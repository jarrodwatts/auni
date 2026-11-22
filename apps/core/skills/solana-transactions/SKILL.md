---
name: solana-transactions
description: Load before building any send_solana_transaction, to use a Solana app no other tool covers (staking, lending, a claim, a swap solana_swap can't make). Covers getting the transaction from the app, what Auni refuses, fees and reading Solana.
---

# Solana transactions

`send_solana_transaction` sends one transaction an app's API built for the owner's Solana
wallet. Auni simulates it and the card shows what leaves and arrives. A trade goes on a
tap; sending assets away, trading tokens Auni can't verify and price, leaving a
permission behind, changing an account an app keeps for the wallet (a lending position,
a stake account, compressed NFTs), moving nothing Auni can see, or a network fee over 0.01 SOL also
checks it's the owner.

Use it only for what Solana alone has. Anything Monad can do is done on Monad, and
`solana_swap` and `stock_trade` already trade Solana tokens and stocks in one tap.

## Get the transaction from the app

- Ask the app's API for a transaction for the wallet: its Solana address is the wallet, the
  fee payer and the only signer. Pass what comes back as `transaction`, base64, legacy
  or v0; convert hex to base64 first.
- No one else may sign it. An app that adds a signer of its own (a new keypair for a
  position, as Orca, Raydium CLMM and Meteora DLMM do) can't be sent here; tell the owner.
- Any blockhash will do: Auni puts a fresh one on it and simulates it again before it goes.
- Keep it small. Ask for fewer accounts where the API allows (an app's skill says how),
  since a wallet short of SOL is simulated with an extra instruction.
- Several transactions are several cards, one call each, in order, each after the last lands.

Name the app in `app` (Kamino and kamino.finance, Jito and jito.network), with `swap`,
`deposit` or `move` when it is one, so the card wears that app's name and logo. The card
also names the program the transaction ends on. Make `summary` a short title that starts
with what it does: "Stake SOL with Jito".

The card says which of its words Auni checked by running the transaction: what leaves,
what arrives, and any permission left. What only you know goes in `app.note`, one plain
sentence: what it earns, how long getting out takes. The card shows it apart, under
"Not checked: what Auni says about it", and leaves it off a card that also checks it's the owner.

## Fees

The wallet pays its own network fee and any rent for accounts the transaction opens, in
SOL. When it holds too little, Auni first buys what it needs with a little of its Solana
USDC, and the card shows that as the network fee. With no USDC on Solana either, move a
little there with `{{BRIDGE}}` first. Ask the app for its usual priority fee rather than
its highest, so the fee stays under what a tap allows.

## Read Solana

Read it with `fetch_url`: the public RPC, `https://api.mainnet-beta.solana.com`, takes a JSON-RPC
call as `json` (`{"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner", "params": [...]}`)
for balances, token accounts and programs. Whether a token is verified, the skill of the app
that lists Solana tokens says how to check: {{SOLANA_TOKEN_SKILLS}}.
