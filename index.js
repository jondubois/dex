'use strict';

const defaultConfig = require('./defaults/config');
const BaseModule = require('lisk-framework/src/modules/base_module');
const { createStorageComponent } = require('lisk-framework/src/components/storage');
const { createLoggerComponent } = require('lisk-framework/src/components/logger');
const TradeEngine = require('./trade-engine');
const liskTransactions = require('@liskhq/lisk-transactions');
const liskCryptography = require('@liskhq/lisk-cryptography');

const WritableConsumableStream = require('writable-consumable-stream');

const MODULE_ALIAS = 'lisk_dex';

// TODO: Add a way to sync with the chain from any height in the past in an idempotent way.
// TODO 2: Take out transaction fees.
/**
 * Lisk DEX module specification
 *
 * @namespace Framework.Modules
 * @type {module.LiskDEXModule}
 */
module.exports = class LiskDEXModule extends BaseModule {
  constructor(options) {
    super({...defaultConfig, ...options});
    this.chainSymbols = Object.keys(this.options.chains);
    if (this.chainSymbols.length !== 2) {
      throw new Error('The DEX module must operate on exactly 2 chains only');
    }
    this.baseChainSymbol = this.options.baseChain;
    this.quoteChainSymbol = this.chainSymbols.find(chain => chain !== this.baseChainSymbol);
    this.tradeEngine = new TradeEngine({
      baseCurrency: this.baseChainSymbol,
      quoteCurrency: this.quoteChainSymbol
    });
  }

  static get alias() {
    return MODULE_ALIAS;
  }

  static get info() {
    return {
      author: 'Jonathan Gros-Dubois',
      version: '1.0.0',
      name: MODULE_ALIAS,
    };
  }

  static get migrations() {
    return [];
  }

  static get defaults() {
    return defaultConfig;
  }

  get events() {
    return [
      'bootstrap',
    ];
  }

  get actions() {
    // TODO: Expose actions for HTTP API.
    return {};
  }

  async load(channel) {
    let loggerConfig = await channel.invoke(
      'app:getComponentConfig',
      'logger',
    );
    this.logger = createLoggerComponent(loggerConfig);

    let storageConfigOptions = await channel.invoke(
      'app:getComponentConfig',
      'storage',
    );
    this.chainSymbols.forEach(async (chainSymbol) => {
      let chainOptions = this.options.chains[chainSymbol];
      let chainModuleAlias = chainOptions.moduleAlias;
      let storageConfig = {
        ...storageConfigOptions,
        database: chainOptions.database,
      };
      let storage = createStorageComponent(storageConfig, this.logger);
      await storage.bootstrap();

      let blockChangeStream = new WritableConsumableStream();

      (async () => {
        for await (let event of blockChangeStream) {
          let block = event.data;
          let targetHeight = parseInt(block.height) - this.options.requiredConfirmations;

          this.logger.trace(
            `Processing block at height ${targetHeight}`
          );

          let blockData = (
            await storage.adapter.db.query(
              'select blocks.id, blocks."numberOfTransactions" from blocks where height = $1',
              [targetHeight],
            )
          )[0];

          if (!blockData) {
            this.logger.error(
              `Failed to fetch block at height ${targetHeight}`
            );

            continue;
          }
          if (!blockData.numberOfTransactions) {
            this.logger.trace(
              `No transactions in block ${blockData.id} at height ${targetHeight}`
            );

            continue;
          }
          let orders = await storage.adapter.db.query(
            'select trs.id, trs."senderId", trs."timestamp", trs."recipientId", trs."amount", trs."transferData" from trs where trs."blockId" = $1 and trs."transferData" is not null and trs."recipientId" = $2',
            [blockData.id, chainOptions.walletAddress],
          )
          .map((txn) => {
            let transferDataString = txn.transferData.toString('utf8');
            let dataParts = transferDataString.split(',');
            let orderTxn = {...txn};
            let targetChain = dataParts[1];
            let isSupportedChain = this.options.chains[targetChain] && targetChain !== chainSymbol;

            if (dataParts[0] === 'limit' && isSupportedChain) {
              orderTxn.type = 'limit';
              orderTxn.price = parseFloat(dataParts[2]);
              orderTxn.targetChain = targetChain;
              orderTxn.targetWalletAddress = dataParts[3];
              let amount = parseInt(orderTxn.amount);
              if (chainSymbol === this.baseChainSymbol) {
                orderTxn.side = 'bid';
                orderTxn.size = Math.floor(amount / orderTxn.price); // TODO: Consider switching to BigInt.
              } else {
                orderTxn.side = 'ask';
                orderTxn.size = amount; // TODO: Consider switching to BigInt.
              }
            } else {
              this.logger.debug(
                `Incoming transaction ${txn.id} is not a valid limit order`
              );
            }
            return orderTxn;
          })
          .filter((orderTxn) => {
            return orderTxn.type === 'limit';
          });

          await Promise.all(
            orders.map(async (orderTxn) => {
              let result;
              try {
                result = this.tradeEngine.addOrder(orderTxn);
              } catch (error) {
                this.logger.error(error);
                return;
              }
              if (result.takeSize > 0) {
                let takerChainOptions = this.options.chains[result.taker.targetChain];
                let takerTargetChainModuleAlias = takerChainOptions.moduleAlias;
                let takerAddress = result.taker.targetWalletAddress;
                let takerAmount = result.taker.targetChain === this.baseChainSymbol ? result.takeValue : result.takeSize;
                takerAmount -= takerChainOptions.exchangeFeeBase;
                takerAmount -= takerAmount * takerChainOptions.exchangeFeeRate;
                takerAmount = Math.floor(takerAmount);

                if (takerAmount <= 0) {
                  this.logger.error(
                    `Failed to take the trade order ${orderTxn.id} because the amount after fees was less than or equal to 0`
                  );
                  return;
                }

                let takerTxn = {
                  type: 0,
                  amount: takerAmount.toString(),
                  recipientId: takerAddress,
                  fee: liskTransactions.constants.TRANSFER_FEE.toString(),
                  asset: {},
                  timestamp: orderTxn.timestamp,
                  senderPublicKey: liskCryptography.getAddressAndPublicKeyFromPassphrase(takerChainOptions.sharedPassphrase).publicKey
                };
                let takerSignedTxn = liskTransactions.utils.prepareTransaction(takerTxn, takerChainOptions.sharedPassphrase);
                let takerMultiSigTxnSignature = liskTransactions.utils.multiSignTransaction(takerSignedTxn, takerChainOptions.passphrase);
                let takerPublicKey = liskCryptography.getAddressAndPublicKeyFromPassphrase(takerChainOptions.passphrase).publicKey;

                (async () => {
                  try {
                    await channel.invoke(`${takerTargetChainModuleAlias}:postTransaction`, { transaction: takerSignedTxn });
                    await wait(this.options.signatureBroadcastDelay);
                    await channel.invoke(`${takerTargetChainModuleAlias}:postSignature`, {
                      signature: {
                        transactionId: takerSignedTxn.id,
                        publicKey: takerPublicKey,
                        signature: takerMultiSigTxnSignature
                      }
                    });
                  } catch (error) {
                    this.logger.error(
                      `Failed to post multisig transaction of taker ${takerAddress} on chain ${this.quoteChainSymbol} because of error: ${error.message}`
                    );
                    return;
                  }
                })();

                await Promise.all(
                  result.makers.map(async (makerOrder) => {
                    let makerChainOptions = this.options.chains[makerOrder.targetChain];
                    let makerTargetChainModuleAlias = makerChainOptions.moduleAlias;
                    let makerAddress = makerOrder.targetWalletAddress;
                    let makerAmount = makerOrder.targetChain === this.baseChainSymbol ?
                      makerOrder.valueTaken : makerOrder.sizeTaken;
                    makerAmount -= makerChainOptions.exchangeFeeBase;
                    makerAmount -= makerAmount * makerChainOptions.exchangeFeeRate;
                    makerAmount = Math.floor(makerAmount);

                    if (makerAmount <= 0) {
                      this.logger.error(
                        `Failed to make the trade order ${makerOrder.id} because the amount after fees was less than or equal to 0`
                      );
                      return;
                    }

                    let makerTxn = {
                      type: 0,
                      amount: makerAmount.toString(),
                      recipientId: makerAddress,
                      fee: liskTransactions.constants.TRANSFER_FEE.toString(),
                      asset: {},
                      timestamp: orderTxn.timestamp,
                      senderPublicKey: liskCryptography.getAddressAndPublicKeyFromPassphrase(makerChainOptions.sharedPassphrase).publicKey
                    };

                    let makerSignedTxn = liskTransactions.utils.prepareTransaction(makerTxn, makerChainOptions.sharedPassphrase);
                    let makerMultiSigTxnSignature = liskTransactions.utils.multiSignTransaction(makerSignedTxn, makerChainOptions.passphrase);
                    let makerPublicKey = liskCryptography.getAddressAndPublicKeyFromPassphrase(makerChainOptions.passphrase).publicKey;

                    (async () => {
                      try {
                        await channel.invoke(`${makerTargetChainModuleAlias}:postTransaction`, { transaction: makerSignedTxn });
                        await wait(this.options.signatureBroadcastDelay);
                        await channel.invoke(`${makerTargetChainModuleAlias}:postSignature`, {
                          signature: {
                            transactionId: makerSignedTxn.id,
                            publicKey: makerPublicKey,
                            signature: makerMultiSigTxnSignature
                          }
                        });
                      } catch (error) {
                        this.logger.error(
                          `Failed to post multisig transaction of maker ${makerAddress} on chain ${makerOrder.targetChain} because of error: ${error.message}`
                        );
                        return;
                      }
                    })();
                  })
                );
              }
            })
          );
        }
      })();

      channel.subscribe(`${chainModuleAlias}:blocks:change`, (event) => {
        blockChangeStream.write(event);
      });
    });
    channel.publish(`${MODULE_ALIAS}:bootstrap`);
  }

  async unload() {
  }
};

function wait(duration) {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}
