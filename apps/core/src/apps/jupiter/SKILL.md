---
name: jupiter
description: Load before checking whether a Solana token is verified yourself, or asking a Solana app's API for a transaction that must stay small.
---

# Jupiter

Jupiter lists and verifies Solana tokens. Its token search,
`https://lite-api.jup.ag/tokens/v2/search?query=<mint>` with `fetch_url`, says whether a token
is verified. A token it doesn't verify and price makes a raw Solana transaction's card also check
it's the owner.

Its swap API takes `maxAccounts=40`, which keeps a transaction small enough for a wallet short of
SOL, whose simulation carries an extra instruction. `solana_swap` already swaps through it in
one tap; build a Jupiter transaction yourself only for what that tool doesn't do.
