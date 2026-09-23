# MALIK presale: 1 USD = 1,250 MLK

## Why a new contract is required

The existing deployed `MalikPreSale` uses `rate = 2,000,000` **MLK per BNB**.
Its ABI has a `rate()` reader but no owner setter, upgrade mechanism, or USD oracle.
Editing the website cannot change how many tokens that immutable deployed code sends.
At a BNB price of $800, the old contract delivers 2,500 MLK for $1 worth of BNB.

`contracts/MalikPreSaleUSD.sol` is a separate sale contract. It reads a BNB/USD
price feed on BNB Smart Chain. The contract computes tokens as
`BNB paid × oracle BNB/USD price × 1,250`. It rejects stale/invalid feed values,
insufficient token inventory, transactions below the buyer's minimum token
amount, and failed token delivery or BNB payout.

## Deployment checklist

1. Verify the **token contract** address by calling `token()` on the old sale
   contract. This is different from the old sale contract address.
2. Choose the current **BNB/USD** Chainlink feed on **BNB Smart Chain mainnet**
   from [Chainlink's directory](https://data.chain.link/feeds/bsc/mainnet/bnb-usd).
   Verify its full address, pair, chain, decimals, and heartbeat before use.
3. Choose `maxPriceAgeSeconds` to match the feed heartbeat and your acceptable
   stale-data limit (at most 86,400 seconds). The example tests use 7,200 seconds;
   this is **not** an automatically safe production value.
4. Deploy `MalikPreSaleUSD(tokenAddress, feedAddress, maxPriceAgeSeconds)` from
   the payout wallet. Confirm `owner()`, `token()`, `bnbUsdFeed()`, `tokenUnit()`
   and `feedUnit()` on the deployed instance. Its new address must differ from
   the old sale address `0x23FEd34C9550D24269bF05F655250873c19BFEB4`.
5. Fund **the new sale contract** with the intended MLK inventory. Existing
   inventory at the old sale does not move automatically. Withdraw old unsold
   tokens only if you control its owner wallet and after checking pending buys.
6. Update the site's sale address, displayed contract address and BscScan link
   together. Remove the old `sendTransaction` raw BNB payment path. Use the
   `buyTokens(minTokensOut)` function, and get BNB wei from `bnbForUsd(usdWad)`.
   Set `minTokensOut = usdWad * 1250 * tokenUnit / 1e18` for the chosen USD amount.
   Use `quote(bnbWei)` for the actual expected tokens. If an oracle update moves
   the quote below the requested minimum, the transaction reverts without
   charging the buyer (gas may still be spent).
7. On a test deployment, buy a small amount and verify the `Bought` event,
   buyer token balance, BNB owner payout and BscScan transaction. Then repeat
   these checks for the mainnet deployment before enabling public purchases.

Do **not** present the existing web-only quote as an on-chain guarantee, and do
not replace a deployed contract by changing its GitHub source. Never share a
private key or seed phrase. The sale contract has not been deployed by this PR.

## Local test

`npm install && npm test` compiles with Solidity 0.8.20 and executes the
contract against a local EVM. Tests cover a $1 sale, price changes, minimum
tokens, invalid/stale oracle data, insufficient inventory and owner payout.
