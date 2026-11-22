---
name: across
description: Load before moving cash between chains, into or out of Solana, buying a token on a chain Auni has no swap for, bringing a token home from another chain, or explaining a bridge that is late or came back. Covers bridge_usdc.
---

# Across

`bridge_usdc` moves money into the owner's own wallet on another chain through Across. Auni sets
the recipient, so it is one tap, and nobody else can be paid by it.

## What it does

- **Cash between chains**: USDC between Auni's chains and Solana, either way (USDC sent in on
  Base, to Solana for a stock; what a Solana stock sale left, back to Monad).
- **Buying on another chain**: from Auni's cash, with `output_token`, it buys a token on any
  chain Across reaches in one card, and Across pays the gas there (WPRL on Ethereum).
- **Bringing a token home**: with `from_token` (its address) it sells any priced token on any
  chain it supports back to USDC as it leaves, such as USDG someone sent on Robinhood Chain.
  Its card reads as a sale: the least it brings back is the figure.

What Across can't reach goes through the evm-transactions skill.

## How a move goes

1. Across quotes it, and builds every byte Auni signs. Its fee comes out of what arrives: a few
   cents of relayer and gas fee on a USDC move between two cheap chains ($10 from Base to
   Arbitrum landed $9.99), more to Ethereum, where its gas is dearer.
2. At the tap Auni quotes again, simulates the deposit from the wallet, and sends only when the
   deposit, as Across's own pool logs it, pays the owner's wallet on the chain the card named at
   least what the card said. A USDC move whose card says only "about" may lose at most 3% on the
   way; one that swaps holds the least on its card.
3. A relayer pays the owner on the other chain, usually within a minute (its docs say most fill
   in seconds). The move stays running until then, and its thread is woken with what landed, so
   never sleep or poll to check on it.
4. If no relayer fills it in time, Across gives it back on the chain it left, about two to two
   and a half hours after the deposit. The thread hears that too. Nothing is lost.

Details that matter:

- Approvals are exact, sent with the deposit as one transaction; on Ethereum, which can't batch
  them, the approval lands on its own first.
- From Solana only USDC goes, and a little of it buys the SOL Solana charges for the deposit, so
  a very small move from Solana is refused. To Solana, the SOL that opens the wallet's USDC
  account there is bought too, the first time.
- On a chain Auni doesn't list, where the wallet pays its own gas, a card it couldn't pay for is
  refused before it is shown.

## When it refuses

Nothing was sent in any of these.

- **Too little to move**: Across's fees would take it all. Offer a larger amount.
- **Too much for the route now**: Across hasn't the money on that route to carry it. Offer a
  smaller amount, or to split it; a card for less shows at once whether it fits.
- **Too many requests**: Across turned Auni away for a moment. Try again shortly.
- **The quote went stale** before it was sent. Trying again quotes it afresh.
- **The price of what is sold moved** past the least its card allowed, before Across swapped it.
  Offer it again at today's price, which is a new card.
- **Deposits are paused** by Across. Wait, or, for USDC between Auni's chains, say there is no
  other way across today.
- **The deposit doesn't match its card** ("Across's deposit pays someone else", "lands less than
  its card said"): Auni refused what Across built. Don't retry blindly; say what happened.
