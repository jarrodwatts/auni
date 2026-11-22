---
name: dexscreener
description: Load before looking up a token on any chain yourself, by name, symbol or address, to find its address, the chain it trades on and how deep its market is.
---

# DexScreener

DexScreener lists the trading pairs of tokens on most chains, with no key needed. Search it with
`fetch_url`: `https://api.dexscreener.com/latest/dex/search?q=<name, symbol or address>`.

Each pair has its chain, the token's address, `liquidity.usd` and 24h volume. Take the address
from the deepest pair on the chain the owner means. Anyone can list a pair, so a token named like
a famous one with a shallow pool is usually not it.
