# Money

Paths are under `apps/core/src/`. The chain is the truth for money; the database holds cards and
what Auni recorded of them.

## How a money move flows

A move's states and steps, who takes each and what a restart does are one file,
`money/life.ts`. Only its `step` changes a move's state (ESLint holds that).

1. The agent calls a money tool. `money/tools.ts` hands it to `proposeAction` (`money/actions.ts`),
   which asks the recipe's `describe` for the card: a summary, the dollars it spends, and its
   effect (what it gives, gets and grants; `money/effect.ts`).
2. `recordActions` saves it as an action row and asks `permissionDecision` (`money/permission.ts`).
   Chats always ask. A specialist set to act on its own runs a buy or sell that fits its pot,
   with what its card buys for fees, in its own thread only: filed under it from anywhere else,
   a move asks. One that runs is queued in the same transaction, as an allowed one is (step 4).
3. Asked: the tool returns a card, which `agent/mcp.ts` seals. The owner taps Allow, which is
   `POST /actions/:id/allow` (`money/routes.ts`): their session alone, plus proof they are
   there (`auth/proof.ts`) when `money/step-up.ts` says so. A tap on a channel's copy of the card
   goes through the same `money/decide.ts`, with the grant the hub drew on it. That copy is one
   message, kept in step by editing it (`channels/draw.ts`); one too long for it shows its
   summary and is allowed in the app.
4. The tap queues it and its `action` job in the same transaction (`decideActions`,
   `queueExecution`), with two lanes (`executionKeys`), so two moves that would race on one wallet
   or one holding run in turn, and an allowed move always has a job. A Decline cancels it and
   wakes its thread the same way, so the agent always hears of a no.
5. `executeAction` claims the row once (a redelivery finds it claimed and stops), checks that
   proof again (`assertStepUp`), gets a signer from the wallet app
   (`money/wallets.ts`), and runs the recipe's `execute`. Execute quotes again and refuses anything
   outside what the card showed (`money/approved.ts`).
6. Each transaction is kept the moment it is sent (`keepTxsSafely`), so a failure halfway leaves an
   honest trail. A recipe that may have sent throws `MayHaveSent`; one that knows nothing moved
   throws `NothingMoved` (both in `money/recipe.ts`). Try again is `money/retry.ts`. A run's
   notes are the row's `run`; `details` is the card as shown, never changed.
7. A move that arrives later (a bridge, money into Hyperliquid) is landing until its recipe's
   `landed` says so (the `landing` job), and what it bought there (`Landed.bought`) is recorded as
   it turns done; one not landed in 12 hours finishes saying so. `money/reconcile.ts` settles
   anything left unsure, on a cron, a trade by its recipe's `readBack`. What nothing can read is
   held: its thread is told once, and its card offers Check again and Close (`money/held.ts`).
   Then the thread wakes to report.

A card that changes Auni itself rather than money (an **ask**: starting a specialist, which only
Auni's own chat proposes, letting one act on its own or raising its pot, or saving a routine) is an
action row too, recorded waiting by `recordAsk` (`asks.ts`) with no venue and no dollars, so steps 3
and 4 decide it on every surface. On Allow, `decideActions` applies it with `applyAsk` in the same
transaction and marks it done (or failed, with why, when Auni changed since the card), and queues
nothing but a started specialist's first turn in its own thread; `executeAction` and Try again
refuse one.

## Chains

Auni reads every chain, with no paid service, through RPCs any node serves
(`money/chains.ts`, `rpcFor`), in this order: `RPC_URL_<CHAIN>` (`RPC_URL_MONAD`, alone, so a fork
or node of the owner's own sees each read and send), else Alchemy when `ALCHEMY_API_KEY` is set,
else the chain's public RPCs (`packages/shared/src/networks.ts`), asked in turn until one answers.

Deposits are found by the sweep (`money/sweep.ts`), from a cursor per network: token Transfer
logs, the chain's own coin from where the wallet's past balance rose, and Solana's signatures; how
it reads spans an RPC refuses or hasn't reached is in `money/evm-history.ts`. It runs as a
reading is taken, as the app opens, and from the `sweep` job. What it can't see shows only in the
balance a reading takes: coin a contract sends on (a bridge's delivery) where the RPC serves no
traces, and coin that came in where the wallet spent more of it within one sweep.

## Where things live

- Auni's own recipes (raw transactions, withdraw, move a holding, convert to cash, stock trade):
  `money/recipes/`. Swaps that ask every route for the best quote: `money/swaps/` (`routes.ts`,
  `evm-swap.ts`; the xStocks catalog in `xstocks.ts`).
- Cards replaced or taken back: `money/waiting.ts`.
- What a card shows: the recipe's `describe` and `money/action-card.ts`. What it says is its
  face: the move's own (`money/card-face.ts`, an app's `card.ts`), else the plain one core makes.
- The wallet: `money/wallets.ts` is core's door to it; `apps/local-key/` the default, and a
  stuck EVM send replaced by fee is its `evm.ts` (`replaceStuck`).
- A chain's coin for its fees, bought on the card when the wallet is short or low, once a card:
  `money/fee-coin.ts` (EVM), `money/sol-top-up.ts` (SOL), `money/fee-coin-said.ts` (words).
- Holdings and value: `money/portfolio.ts`, `money/chain-holdings.ts`, `money/books.ts` (who holds
  what, by fills), `money/readings.ts` (the `reading` job, `jobs/readings.ts`), `money/holdings.ts`,
  `money/value-history.ts`; what a first look finds is put in (`money/first-look.ts`).
  Prices: `money/history.ts`, from the account holding it, else the token feeds
  (`money/token-feeds.ts`).
- Money arriving: `money/arrivals.ts`, `money/sweep.ts`, `jobs/sweep.ts`. A venue's own record of
  what traded there: `money/statements.ts`, `jobs/statements.ts`.
- Paying in from a browser wallet: `routes/funding.ts`, and `money/pay-in.ts`, which holds the
  pay-in app's quote to what was asked.
- What Auni tells a thread unasked of money (a landing, an arrival): `money/news.ts`.
- A specialist's pot: `money/pot.ts`. The agent's chain reads (`read_chain`): `money/read-chain.ts`.
