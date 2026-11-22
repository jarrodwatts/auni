---
name: kyberswap
description: Load before swapping a token on an EVM chain by building the transaction yourself, where evm_swap doesn't trade it or doesn't reach the chain. Covers quoting and building a swap through KyberSwap's API and sending it with send_evm_transaction.
---

# KyberSwap

KyberSwap's aggregator finds a route for almost any pair on most EVM chains and builds the swap's
calldata for its router. On Monad, Base, Arbitrum and Polygon, `evm_swap` already asks it beside
the other routes, in one tap: use that there. Build a swap yourself only where `evm_swap` doesn't
reach or doesn't trade the token, and send it with `send_evm_transaction`.

Its router is `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` on Monad, Base, Arbitrum, Polygon,
Ethereum, Unichain and BNB Chain. A swap sent to it there reads on its card as KyberSwap's, under
KyberSwap's name, whatever you put in `app`, and says how far the price may slip before it fails.
If the API ever names another router, stop and say so rather than send to it.

## Route a swap

Call each with `fetch_url`. `<chain>` is KyberSwap's name for it: ethereum, base, arbitrum,
polygon, monad, unichain, and bsc for BNB Chain.

1. Quote: `https://aggregator-api.kyberswap.com/<chain>/api/v1/routes?tokenIn=<addr>&tokenOut=<addr>&amountIn=<base units>`.
   The chain's own coin is `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`. The answer's
   `data.routeSummary` is the route and `data.routerAddress` the router.
2. Build: POST to the same host's `.../api/v1/route/build` with `json`
   `{"routeSummary": <data.routeSummary>, "sender": <wallet>, "recipient": <wallet>, "slippageTolerance": 100, "source": "auni"}`.
   The recipient is always the owner's own wallet. `slippageTolerance` is in hundredths of a
   percent: 100 is 1%, and the swap fails rather than fill if the price slips further before it
   lands. Go wider only for a thin or fast-moving token, and say so to the owner.
3. If the token in is an ERC-20, check the allowance for the router with `read_chain`. If it is
   short, put `approve(routerAddress, amountIn)` to the token first in the same batch as the
   swap. The exact amount is spent to nothing, so the trade goes on a tap; a standing allowance
   the owner asks for is fine, but its card also checks it's them. On Ethereum each call is its own
   transaction, so an approval and a swap there always check it's the owner: sell a token there with
   `bridge_usdc` instead.
4. The swap call: `to` is `routerAddress`, `data` the built `data`, `value` the built
   `transactionValue` in wei. The calldata runs to thousands of characters: copy it whole,
   exactly as built.

## What to know

- A route goes stale within minutes. If Auni says the batch would have failed when it ran it
  first, quote and build again rather than editing the hex.
- KyberSwap charges no fee of its own on a swap. It keeps anything a swap gets above the amount
  its quote expected (its "positive slippage"), and the owner is guaranteed at least the least
  amount the slippage allows, or the swap fails and costs only gas.
- Its API answers an error with a `code` and `message`: 4008 is no route for the pair, 4009 an
  amount over its maximum, 4010 no pool to route through, 4011 a token it can't find. Say which
  plainly, and try a smaller amount, another pair, or `bridge_usdc` to bring the token home.
- A card shows what the simulation saw leave and arrive. If what arrives is far from the quote,
  or a token is new or thin, say that in one sentence before the owner taps.
