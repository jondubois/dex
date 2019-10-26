# lisk-dex
Decentralized exchange module for the Lisk network. Note that lisk-dex is a community project and is not affiliated with Lightcurve or Lisk Foundation.

## DEX protocol

### Actions

To send an order to the DEX, a user needs to send a regular transfer transaction to the DEX's multisignature wallet address with one of the following commands in the transaction's `data` field.

- **Limit order**: `${targetChain},limit,${bidOrAskPrice},${targetWalletAddress}`
- **Market order**: `${targetChain},market,${targetWalletAddress}`
- **Cancel order**: `${targetChain},cancel,${orderId}`

When making a limit or a market order, the DEX will use the amount of the underlying transaction to derive the quantity of counterparty tokens to acquire.
When performing a cancel order, the amount is not relevant; in this case, any amount can be specified as part of the cancel transaction (less is better); in any case, whatever amount is specified (minus blockchain transaction fees) will be refunded to the user as part of an `r3` refund transaction.

### Responses

These status codes and messages appear in transactions created by the DEX (as part of the transaction `data` field):

**Refunds**

- `r1,${orderId}: Invalid order`
- `r2,${orderId}: Expired order`
- `r3,${orderId},${cancelOrderId}: Canceled order`
- `r4,${orderId}: Unmatched market order part`
- `r5,${orderId},${newWalletAddress}: DEX has moved`
- `r6,${orderId}: DEX has been disabled`

**Trades**

- `t1,${takerChain},${takerOrderId}: Orders taken`
- `t2,${makerChain},${makerOrderId},${takerOrderId}: Order made`

### Behaviors

- If the DEX does not recognize a command/order from a user, it will send an `r1` refund transaction back to the user's wallet address which will return the full amount of the original transaction minus any blockchain transaction fees incurred by the DEX.
- A DEX adheres to a fixed order expiry (e.g. 1 month). If an order expires before being filled or canceled, the DEX will issue an `r2` refund transaction back to the user's wallet address which will return the full amount of the original transaction minus any blockchain transaction fees incurred by the DEX.
- If a pending limit order is canceled by the original user using a `cancel` action, the original order transaction amount (minus blockchain transaction fees) will be refunded back to the user's wallet address using an `r3` refund transaction.
- If a market order is made which cannot be completely filled by a counterparty limit order, then any unmatched part of the market order (minus blockchain transaction fees) will be refunded back to the user's wallet address as an `r4` refund transaction.
- If the majority of DEX operators have agreed to move the DEX to a new multisig wallet address, the DEX will answer all transactions with a full refund (minus blockchain transaction fees) using an `r5` transaction. The DEX is required to keep refunding transactions sent to the old address for at least 6 months to give clients time to update their caches to point to the new address.
- If the majority of DEX operators have agreed to shut down the DEX, the DEX will answer any order with a full refund (minus blockchain transaction fees) as an `r6` transaction. The DEX is required to keep refunding transactions sent to the last active address for at least 6 months to give clients time to update their caches to point to a different DEX.
- The DEX may behave somewhat differently from a typical centralized exchange when processing limit orders. In a typical centralized exchange, the last order received by the matching engine will be given the best available deal (so long as the trade price at least as good or better than the specified bid/ask price). With the DEX, however, the limit order will be given a deal according to the bid/ask price specified in the order, even if a better deal is available. The DEX multisig wallet will keep any difference as profit. For this reason, if the user wants fast conversion, it is generally cheaper to just use a market order.
