# Moves, an account, a reader, a job for core

A venue is an app that moves money; a reader is an app that names the transactions Claude builds
for its contracts. `App` in `contract.ts` lists every part, each optional and all on one level.
Core never names an app: it asks the registry (`registry.ts`), so a second venue is one folder.
`pnpm scaffold <id> --with moves,account` writes a venue that core accepts and that sends nothing
(only `apps.test.ts` fails, until its words for Claude are written), and `--with reads` a reader. Each part starts from the real app below, or from its
fake in `../test/second-venues/`:

| Part      | What core does with it                                            | Copy from                                              |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `moves`   | Money tools the agent calls, each a card the owner allows         | `aave/aave.ts`                                         |
| `account` | Reads, prices and names the money the owner keeps there           | `aave/`, `hyperliquid/`, `polymarket/`, the fake vault |
| `reads`   | Names a transaction Claude built for one of its `addresses`       | `kyberswap/reader.ts`                                  |
| `swaps`   | Quotes EVM swaps, beside every other route                        | `kyberswap/`                                           |
| `solana`  | Lists, prices and quotes Solana tokens, beside every other route  | `jupiter/`                                             |
| `bridge`  | Moves the owner's USDC between their chains, for core's own moves | `across/`                                              |
| `payIn`   | Quotes carrying USDC in from another chain, which core checks     | `relay/`                                               |
| `tokens`  | Says what tokens are and what they are worth                      | `defillama/`, `lifi/tokens.ts`, `coingecko/`           |

`../money/second-venues.test.ts` and its `.db` twin install those fakes beside the real ones, with no edit to core, and prove each reaches the
agent's tools, its cards and the portfolio. Every venue passes the same checks
(`../test/venue-rules.ts`, which `apps.test.ts` runs on every app).

## A recipe (money tools)

A recipe is a `Recipe` (`../money/recipe.ts`, which documents every field). `aave/aave.ts` is a
short, complete one. The parts that matter:

- `tool`, `description`, `input`: the tool the agent sees. Its `venue` is the app's id.
- `describe(input)`: what the card shows, before anything runs. `effect` lists what the move gives,
  gets and grants (`../money/effect.ts`); `amountUsd` is the dollars it spends.
- `card`, in what `describe` returns: how the move's own card reads, as a `CardFace`
  (`packages/shared/src/card-face.ts`): its title, button, figures and receipt, as plain data the
  web app and every channel draw alike. Write `AMOUNT` wherever the card's dollars go, never a
  figure of your own: core fills in the amount it priced. The drill below fails a face that
  spends and never says `AMOUNT`, and a title, a button or a figure of what the owner pays ("You
  pay", "You put in", "Amount") that types dollars itself. `polymarket/card.ts` and `hyperliquid/card.ts` are two. Leave it out and
  the card reads as the plain face core makes of `summary` and `effect`
  (`../money/card-face.ts`), as Across's does.
- `execute({ input, wallets })`: quote again, refuse anything outside what the card showed (the
  checks in `../money/approved.ts`), send with `wallets`, and return the transactions and fills.
  Approve exactly the amount spent, in the same batch, as Aave does.
- `sends`, in what `describe` returns: the EVM calls the card would send from the wallet, where
  describe already has them (a quote that came with its transactions). Core asks the chain what
  they cost and, where the wallet is short of the chain's coin, puts buying it on the card or
  makes no card (`../money/fee-coin.ts`), so a recipe never checks fees itself and execute
  changes nothing: the wallet it is handed buys the coin as its first send needs it, once for
  the card. Every drawing of the card says the purchase (`../money/fee-coin-said.ts`), it
  counts in a specialist's pot and a plan's sums, and a move whose coin never came fails as
  `fees`, which Try again runs without buying again.
- `about`: what the move is about (a `Subject` in `recipe.ts`, or null), which its card's picture
  is drawn from.
- `direction`, `fundedFrom`, `readies`, `landed`: optional; read their notes in `recipe.ts` to
  see which a move needs. `fundedFrom` and `readies` name where its cash comes from
  and lands (a network, or a venue's account by its app id), which orders a card's moves
  (`../money/proposal-order.ts`). `landed` is for money that arrives somewhere else later.
- A send whose answer never came back throws `MayHaveSent`; one that sent but knows nothing moved
  throws `NothingMoved`. Never report a failure that may have moved money.
- Post anything that moves money off chain (an order to the service's book, a withdrawal it pays
  out) inside `posting(chain, post)` from execute's context: the move is kept as maybe sent
  before the post goes, so a run cut off before the service answers is held, not failed.
- What the service says when it refuses goes through the app's `problems.ts` (`Problems` in
  `contract.ts`): `said` reads what went wrong from an answer as your code receives it, and
  `known` lists each refusal you know, with the kind of failure it is and the sentence the owner
  reads, which says what happened and what became of their money. Throw
  `refused(about.name, problems, message)` (`../money/refused.ts`) where the move reads an
  answer. Each row names a fixture under `fixtures/problems/`: `{ "from", "answer" }`, the
  answer as the service gave it and where it came from (recorded with a throwaway key that can
  move no money, or the page of the service's docs that gives it). `apps.test.ts` reads every
  fixture through `said` and fails a row whose pattern misses its own answer or is shadowed by
  an earlier one. A message a move throws is read by the owner on the card and in a channel, so
  write each as a sentence for them; what Claude should do next belongs in `SKILL.md`.
  `hyperliquid/problems.ts` is the one to copy for a service's API. For a contract that
  reverts, a node says so before anything is signed (the wallet's estimate, or core's
  simulation), and `revertOf` (`../money/refused.ts`) finds the bytes it reverted with in the
  error: `said` decodes them with the contract's errors, as `aave/problems.ts` does. A send
  that may have gone carries none, so it is never taken for a refusal.

Then add each tool to `about.ts` as `kind: "money"` with its `copy`, and `sends: true` when its card
should tick "Sent" before it lands. Add `mark` and a `logo.svg` for the venue's own tile on cards;
without one its cards wear Auni's. Tests go beside the file (`aave/aave.test.ts`). Every recipe
also has a drill, `holdsToCard` in `../test/held-to-card.ts`: against a fake of the venue's API, it
proves that what execute signs is exactly what the card showed, and that execute refuses, sending
nothing, once the price moves against the owner, once it would take more than the card approved,
and once it would pay somewhere the card didn't show (`aave/aave.held.test.ts` is short,
`polymarket/order.held.test.ts` fuller). The fake must answer every request execute makes, and
the drill runs each card again with its bounds narrowed, where execute must refuse or still
fit that card.
`../money/held-to-card.test.ts` fails for a recipe with none.

## A reader

The cheapest app that makes Claude's own transactions read well: no money code at all.
`kyberswap/` is the one to copy: its `SKILL.md` teaches Claude to build a swap through KyberSwap's
API, and `reader.ts` names what that swap does. A reader is three things:

1. **`addresses(chain, owner)`**: the contracts the owner reaches through the service, by
   lowercased address, on the chains where you have checked them. Pin each with a test against
   what the service itself says, recorded as a fixture: KyberSwap's API names its router in
   every answer (`kyberswap/fixtures/routers.json`), and `reader.test.ts` fails if a chain or
   the address differs. A transaction Claude builds with `send_evm_transaction` whose every call
   goes to one of them, or approves one of them to spend a token, and whose last call goes to
   one, wears the app's name and logo, whatever the agent's own hint said
   (`../money/readers.ts`). A batch that also calls anyone else is the plain card, so an app
   never vouches for a payment to a stranger.
2. **`reads(chain, calls, seen)`**: the few words for it (`Reading`). It is synchronous and
   reads only what it is handed: decode the last call with the contract's own ABI and return
   null for any call you don't know. Give a `verb` ("swap", "deposit" or "move" draw that
   layout when the simulation fits it), a `title` with no dollar figure in it where the layout
   can't name the card better itself (a swap's layout says "Sell ETH" from the simulation, so
   KyberSwap gives none), and one line of `finePrint` that no simulation shows: KyberSwap's
   says how far the price may slip before the swap fails, read from the least the call lets
   arrive against what `seen` got. One that throws, says nothing, or types dollars into its
   title leaves the plain card under the app's name.
3. **A test with real answers**: record the service building a real call for a wallet that
   never held money, run it with `eth_simulateV1` on a fork (`anvil --fork-url <rpc>`), and
   keep both as a fixture. The test reads the recorded logs with `walletEffect`, checks the
   words your reader gives, and checks through `send_evm_transaction`'s `describe` that the
   card shows the same figures as the same call where the agent named the app itself
   (`kyberswap/reader.test.ts`).

What a reader cannot touch: what is sent and got, every permission, the amount, and whether the
card takes a tap or the owner's proof all come from the simulation alone. Put what Claude needs to build
the call in the app's `SKILL.md`, and add a demo scene that sends one (`demo/scenes.ts`,
`kyber`), so the card shows in `pnpm demo:shots`.

## A job for core's own moves

An app that does one of these is part of core's own money path, so it is reviewed as core's
money code is, and the owner can't switch it off. For four of them the first answer wins
(`bridge`, `payIn`, `solana`, `tokens`), and who is asked first is written in `order.ts`, never
left to a folder's name: such an app adds its id to the end of that role's list, the one line
outside its folder it changes, and `apps.test.ts` fails until it has.

### `swaps`

`quote(request)` returns exactly the trade asked for (`EvmRoute` in `../money/swaps/evm.ts`), paying
what the wallet gets after every fee, and given a taker the `send` that makes it; or it throws a
plain reason ("no book for this stock"), which the agent reads if no route can quote. Core asks
every route at once and takes the one that pays most (`../money/swaps/routes.ts`): `evm_swap`
asks those whose `trades` is `"any"`, `stock_trade` asks all of them. `books` lists the stocks it
trades at any size, which `stock_trade`'s description names. `kyberswap/` trades any pair; `kuru/`
only Monad xStocks against USDC.

### `solana`

`search`, `tokens` and `price` list and price Solana tokens; `quote` and `build` make a swap. Core's
`solana_swap` (`../money/swaps/solana-swap.ts`) quotes every route and pins the one that gets the
most by name, and execute builds on that route. Searches, prices and core's own swaps (buying SOL
for fees, `../money/sol-top-up.ts`) go through the first route `order.ts` names.

### `bridge`

`recipe` is its money tool (also in `moves`, so start it with `--with moves`); `quote` says what
would land and `send` sends, refusing to once less would land than `approved` allows; `input`
writes its own tool's input for a leg core adds to a card, so core knows no bridge's field
names. Core's own moves go through the first bridge `order.ts` names: a withdrawal to another
chain (`../money/recipes/withdraw.ts`) quotes through it and pins it on the card
(`details.bridge`), sending through that one, and a card paying with a holding on another chain
moves it with its recipe (`../money/pay-with-holdings.ts`). With none, a withdrawal there says
so, and a card asks for the money rather than bring it across. `across/` is the one to copy.

### `payIn`

Quotes carrying USDC, or a chain's own coin, from one chain to a recipient on another as steps
the sender's own wallet sends: the SOL a wallet that pays its own Solana fees buys
(`../money/sol-top-up.ts`), and the coin an EVM chain's fees are paid in, bought from a chain that
can pay (`../money/fee-coin.ts`). The app asks its service and reads the answer into core's names
(`quote`, and `status`, which names the transactions that paid the recipient once it succeeded),
and says two things
of its own contract: its `depository`, and how a call to it reads as a `deposit`. Core holds
every answer to what was asked before anyone sees or signs it (`../money/pay-in.ts`): an exact
approval of that depository and one deposit of exactly the amount from the sender, or for a
chain's coin one deposit that carries exactly the amount, paid to the recipient asked for.
`relay/` is the one to copy, with its recorded quotes.

### `tokens`

A token feed says what tokens are and what they are worth, for every token no account owns.
Every member is optional, and core takes each answer from the first feed in `order.ts` that has
one (`../money/token-feeds.ts`): `prices` (now, or near a past moment), `history`, `day`,
`listing` (what an EVM token is), `logo`, `listed` (the list Auni recognises a token by) and
`stocks` with `marketNote` (the tokenized stocks). A feed leaves out what it doesn't know and
throws when it can't be read, so an unread price leaves a reading partial and never shows as a
loss. `pnpm scaffold <id> --with tokens` starts one that prices nothing; `defillama/`,
`lifi/tokens.ts`, `coingecko/`, `dexscreener/` and `backed/` are the ones to copy.

## The account

`account` (`Account` in `contract.ts`) is the one way a venue slots into the portfolio: where the
owner's money sits there, what it is worth and how it reads. Core asks the registry about
accounts and never about a kind of venue (`accountOwning`, `ledgerAt`, `isMargined`,
`savingsTokens`, `chainCash` in `registry.ts`).

**`kept` says where the money is, which decides who reads it and which holdings are the
account's own.** One of three, each saying its own in the form that fits it:

- `{ wallet }`: tokens in the owner's own wallet (savings, a vault's shares), every one of them
  listed as `{ chain, instrument, symbol }`. Core reads each balance itself, as it reads any
  wallet token, and because the account vouches for each, one sent in from outside Auni is
  recognised, counted and priced by the account, with no public list or feed asked.
- `{ ledger }`: a ledger of the venue's own, on no chain (`hyperliquid/`). Core files its
  holdings, fills and cash under the app's id: a position's key is `{ chain: <id>,
instrument: <market> }`, and everything filed there is its own. A send there has no chain
  receipt to read, so only this means "this place is not a chain", and no app's id may be a
  network's (`apps.test.ts`).
- `{ chains, read, owns }`: contracts on those chains that are not the owner's wallet
  (`polymarket/`'s deposit wallet). Core reads each chain by itself, so one chain's outage hides
  only its own. What it owns there is a set too open to list (every outcome a market could
  mint), so `owns(key)` tells one by its shape, and core asks it only of a key on its chains.

A `ledger` or a `read` returns positions and any cash waiting there, and core lists the source
as unavailable while it throws. Every position it reads must be its own, and no account owns a
chain's coin, a dollar token or a token another account lists (`apps.test.ts`): core prices and
names a holding through the account that owns it, and never a token feed.

**What every account says:**

- `face(holding)`: how one of its holdings reads in the portfolio: its name, the line under it,
  and its picture (null for the app's logo).
- `moneyIn` and `moneyOut`: the move of its own that puts money there and the one that brings it
  back to the wallet, or, where there is none, the plain words the owner reads instead. Both are
  required, so how money gets in and out is never left unsaid.

**What it adds where it applies:**

- `prices`: what one of its holdings is worth, live and over time, for the portfolio's value and
  its chart alike. Core asks it before any feed, so a vault's shares no feed lists are worth what
  the vault says (`../test/second-venues/vault.ts`). A price it can't give marks the read
  partial, so it never shows as a loss. Left out when each holding is a dollar.
- `margined`: its positions are leveraged, so each can be short and is worth its margin plus
  what it made. The owner can't turn the app off while one is open.
- `cash`: how cash waiting there counts, one of three (`AccountCash`), and core's funding knows
  no other:
  - `ledger`: free cash in the account's ledger, which a card's picks there must fit
    (`uncoveredAccounts` in `../money/funding.ts`); `outFeeUsd` is what taking it out costs.
  - `chain`: dollar tokens on a chain, which a buy there spends before the wallet's USDC and
    which core counts as that chain's cash. Its `tokens` never take a withdrawal.
  - `savings`: a wallet token counted as cash at a dollar, filed as "Savings on <name>".
    `token(chain)` names the pool cash goes into and the token it is held as (null where it has
    no market). Core never sends a withdrawal to it and tells money its pool pays out from a
    deposit (`../money/arrivals.ts`). Each whole unit must be worth one USDC, as an Aave aToken
    is; shares priced by a rate are a holding the account `prices`, not cash.
- `statement(owner)`: the account's own record of its trades, a liquidation included, which core
  reads on and records under the app's id (`../money/statements.ts`), hourly and in the
  sweep, once money has moved there through Auni. Its `tool` is listed in `about.ts` as
  `kind: "recorded"`.
- `payouts`: what it paid out by itself for holdings the books still have. Core records each as
  a done move of `payouts.tool` (listed in `about.ts` as `kind: "recorded"`), selling the shares
  it closed (`../money/payouts.ts`).
- `market(instrument)`: one of its markets as a person reads it, held or not, for a move's name
  and its news.
- `detail`: what one of its picks shows when opened on a card.
- `find`: what it trades under a theme or name, for `find_instruments`, which names each by the
  app's `about.name`. Each says its `kind` in a word of the app's own ("perp", "prediction")
  and the `tool` that trades it, which takes its `identifier`.

## Every venue

- `addresses`, even without a reader: what some addresses are to the owner ("an Across bridge"),
  for the story of how money came in, and the name a transaction to them wears.
- `relayed`: a send its relayer took, which has no hash yet.
- `oneAtATime`: every move of the app runs one after another, never two at once, for a service
  where two at once would race (`hyperliquid/index.ts` and `polymarket/index.ts` say why each
  needs it). It is said once for the app, and a move never names a lane of its own.
- `noNewPositions`: for a service that refuses by where this machine is, why it takes no new
  positions from here now, or null. Core asks it before any card with a buy there, so no money
  moves toward an order the service would refuse, and the app's sheet says it
  (`polymarket/region.ts`, from Polymarket's own check).
- A move that lands somewhere else later pins where in its details as `arrivesOn` ("Hyperliquid",
  "Base"), which its card's steps say it is on its way to.
- `guide`: its sentence in the system prompt's "What Auni does": "Perps trade on Hyperliquid."
- `SKILL.md`: what Claude reads before using its tools, and the line `load_skill` and
  `picking-a-venue` list it by (its `description`). It names every tool the app gives Claude.

Nothing outside the folder changes for a venue or a reader but what `pnpm gen` writes. An app
in a role whose first answer wins adds its id to `order.ts`; a `file` setting gets a line in
`apps/core/.env.example`, the one place an owner reads what the settings file may hold.
