---
name: defillama
description: Load before pricing a token yourself on an EVM chain, by its address, when no tool has priced it for you.
---

# DefiLlama

DefiLlama prices tokens by chain and address, with no key needed. Call it with `fetch_url`:
`https://coins.llama.fi/prices/current/<chain>:<address>`, where chain is DefiLlama's name for
it (ethereum, base, arbitrum, optimism, bsc...). A token it has no price for is missing from
`coins` in the answer; say so rather than guess one.
