---
name: evm-transactions
description: Load before buying a token or calling a contract on an EVM chain that evm_swap and the bridge don't cover, before building any send_evm_transaction, and before telling the owner a token can't be bought. Covers finding and pricing tokens, approvals, reading chains and gas.
---

# EVM transactions

`send_evm_transaction` sends a batch of calls you built from the owner's EVM wallet.
Auni simulates it and the card shows what leaves and arrives. A trade or a claim goes on
a tap; sending assets away, trading tokens Auni can't price, getting back under half
the worth of what left, leaving a permission behind, a call Auni can't see do anything
(a vote, a lending switch), or a batch that can't be simulated also checks it's the owner. Use it when no other
tool fits; on Monad, Base, Arbitrum and Polygon, `evm_swap` buys tokens in one tap, and
`{{BRIDGE}}` with `output_token` buys from cash on any chain the bridge reaches, in one tap.

Name the app the batch uses in `app` (Uniswap and uniswap.org, Lido and lido.fi), with
`swap`, `deposit` or `move` when it is one, so the card wears that app's name and logo.
Make `summary` a short title that starts with what it does: "Stake ETH on Lido".

The card says which of its words Auni checked by running the batch: what leaves, what
arrives, and any permission left. What only you know goes in `app.note`, one plain
sentence: what it earns, how long getting out takes. The card shows it apart, under
"Not checked: what Auni says about it", and leaves it off a card that also checks it's the owner.

## Find and price the token

- To look a token up and price it yourself, load {{TOKEN_SKILLS}} first. Take the
  address from the deepest market on the chain the owner means.
- A coin with its own chain usually trades on EVM chains wrapped, often as W plus its
  symbol (Pearl is WPRL on Ethereum). Search for that before saying it can't be bought.
- A name with several tokens behind it, a pool with little liquidity, or a token
  launched days ago is worth one sentence to the owner. Say it once, then propose.

## Read the chain

`read_chain` reads any EVM chain over JSON-RPC, a batch of calls at a time:
`{"chainId": 1, "calls": [{"method": "eth_call", "params": [{"to": "0x...", "data": "0x..."}, "latest"]}]}`.
Use it for balances, allowances, decimals and checking that an address is a contract.

## Route a swap

To swap a token yourself on any chain `evm_swap` doesn't reach, route it through an
aggregator: the skills in picking-a-venue's list say which, with its API, its router and how to
build the batch.

## Gas

On a chain Auni doesn't list, the wallet pays its own gas in the chain's coin. Check that
balance with `eth_getBalance` first, and if it is empty or only dust, bridge a couple of
dollars of the coin there with `{{BRIDGE}}` (`to_chain` the chain id, `output_token` the
zero address `0x0000000000000000000000000000000000000000`), and tell the owner once that it
pays for gas there.

## Getting money there

Cash is USDC on {{CASH_NETWORKS}}. To spend it elsewhere, bridge it with `{{BRIDGE}}` to
the chain id first, as USDC or straight into the token. To sell a token anywhere else and
bring the money home, call `{{BRIDGE}}` with `from_chain` its chain id,
`from_token` its address and `to_chain` monad: the bridge swaps it to USDC as it leaves, on
one card and one tap. Only when the bridge can't quote it, sell it for USDC on its chain (not USDT:
only USDC is cash) and bridge the USDC back.

Trade the amount the owner names. If fees make another amount wiser (selling everything
in one go, say), suggest it in words, but the card is for what they asked.
