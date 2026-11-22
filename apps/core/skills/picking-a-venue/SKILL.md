---
name: picking-a-venue
description: Load when it isn't obvious which Auni tool fits a trade or money move. Maps stocks, tokens, withdrawals and anything else on-chain to Auni's own tools, and each app that is on to its skill and tools.
---

# Picking a venue

Auni can make any on-chain move. Pick the tool that fits; each one sizes, quotes and
records the move so the card shows the owner real facts.

Auni's own tools:

- **Stocks**: `stock_trade`, which buys tokenized shares.
- **Solana tokens**: `solana_swap`, rather than building a Solana transaction yourself.
  `find_instruments` lists Solana tokens deepest first with their liquidity.
- **Tokens on Monad, Base, Arbitrum or Polygon**: `evm_swap`.
- **Money leaving the account to someone else's address**: `withdraw_usdc`. It checks
  the address with the owner.
- **Anything else on-chain**: the evm-transactions skill, or the solana-transactions skill
  only for what Monad can't do.

Each app that is on, with its skill and its tools (load its skill before using them):

{{APPS}}
