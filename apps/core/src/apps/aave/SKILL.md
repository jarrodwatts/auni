---
name: aave
description: Load before putting cash away to earn, taking savings out, or answering what savings pay or why they can't come out. Covers Aave's USDC savings on Monad, Base, Arbitrum and Polygon.
---

# Aave

Savings are USDC lent into Aave V3's USDC market on one chain: Monad, Base, Arbitrum or Polygon.
The owner gets aUSDC in their own wallet, one for each dollar, and its balance grows by itself as
interest accrues, every block. So savings count as the owner's cash, a dollar each, and earn
until they are taken out. aUSDC sent in from anywhere else is recognised as savings too.

## The two moves

- `aave_supply` puts USDC from the wallet into the market on the same chain. The card shows the
  market's rate now. It approves exactly the amount it supplies, in the same transaction, so no
  approval outlives it. The wallet must hold the USDC on that chain already: bridge it first
  with `bridge_usdc` if it sits elsewhere.
- `aave_withdraw` takes USDC out to the wallet on that chain. Asking for the whole balance (or
  more) takes everything, interest earned up to that moment included, so no aUSDC dust is left.
  Read the balance from the portfolio, since it has grown since it went in.

Both are one tap, and a specialist set to act on its own may move its pot in and out by itself.

## How the rate works

Each market pays its own variable rate, set by how much of its USDC is lent out: the more is
borrowed, the higher the rate, so it moves hour to hour. The card reads it from the pool when it
is made. Before you quote a rate in words, read it live with a search rather than recalling one,
and say it is variable. Save on the chain where the cash already sits: bridging costs more than
a small difference in rate earns back on most amounts.

## When it refuses

Nothing was sent in any of these; a node said the pool would refuse before anything was signed.

- **The market is full** (its supply cap is reached). Offer another chain's market, bridging
  there if the cash isn't on it, or leave the cash as it is.
- **The market is frozen**: it takes no new savings, and what is there can still come out.
  Offer another chain.
- **The market is paused**: nothing goes in or out until Aave lifts the pause. Savings there are
  still the owner's. Say so plainly; there is nothing to do but wait.
- **The pool has lent out too much to pay back now.** Withdrawals take only what isn't lent out.
  When nearly all of it is, Aave raises its rates sharply, which draws borrowers to repay and
  new savings in until cash frees up. Offer a smaller amount now, or to try again later.
- **Less saved than asked**: read the portfolio for what is there and offer that.
- **Not enough USDC in the wallet** on that chain: offer the amount it holds, or to bring cash
  there first.
- **Too small to move**: an amount that rounds to nothing in the pool. Offer a real amount.

## What Auni can't do here

Savings are USDC only, on these four chains, and Auni never borrows against them. Lending
another token, or on another chain, is a transaction you build yourself (load
`evm-transactions`), and what it returns shows as a token held, not as savings.
