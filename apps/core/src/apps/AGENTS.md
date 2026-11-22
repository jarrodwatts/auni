# Apps

An **app** makes one outside service great in Auni instead of merely possible. Claude can already
do anything on a chain: it builds the transaction, core simulates it and shows exactly what it
will do as a card, the owner taps Allow, and the wallet signs only what the card showed. An app
adds two layers over that, and core changes for none of them:

- **The helper layer**, what Claude knows and can do there: its `SKILL.md`, its lookups, and its
  moves (money tools for what a bare transaction can't say or hold, such as an exchange order).
- **The visual layer**, how it reads: the words on the card of a transaction Claude builds for
  it, the face of each of its moves, its account in the portfolio, its own cards.

An app may also do a job for Auni itself, a **role**: quote a swap, bridge cash, price a token,
think, sign, carry messages, watch the world. Every part is optional, so an app comes in three sizes, each
finished at its size:

| Size     | In the folder                | What the owner gets                              |
| -------- | ---------------------------- | ------------------------------------------------ |
| Know-how | `SKILL.md`                   | Claude stops working the same thing out twice.   |
| Reader   | plus `addresses` and `reads` | A transaction Claude built reads as a real card. |
| Venue    | plus moves and an account    | What a transaction can't do, held to its card.   |

Three rules hold it together, and ESLint and `apps.test.ts` hold them:

1. **An app only proposes.** Core decides, seals the card, holds the move to it and signs.
2. **Core never names an app, and no app imports another.** An app imports core and
   `contract.ts`; core reaches apps only through `registry.ts`, and loading an app never loads
   the registry (a core file an app imports reaches it with `await import()`).
3. **With no app, Auni does it anyway**: Claude builds the transaction and the card says what the
   simulation saw. An app makes that read well, fail well and need no rediscovery.

## The folder

```
apps/<id>/            the folder's name is the app's id
  about.ts            what it is, as plain data the web reads (imports only types from @auni/shared)
  index.ts            export default defineApp({ about, ...parts })     (contract.ts)
  SKILL.md            what Claude knows: name, description (when to load it), the steps
  logo.svg|png        its picture on cards and in the list
  <move>.ts           a money tool, with its <move>.test.ts and its drill, <move>.held.test.ts
  problems.ts         what the service says when it refuses, in the owner's words
  tables.ts           its own database tables, each named <id>_<name>
  <view>.card.tsx     a card of its own, with <view>.schema.ts, the data it is handed
  *.ts, *.test.ts     the rest of its code, each test beside its file
```

`pnpm gen` wires every folder in (core's list, the web's list of each `about.ts`, logos, views,
`CODEOWNERS`); nothing is registered by hand, and `pnpm gen:check` fails when it is stale.

## The parts (`contract.ts`, which documents each)

- **Helper**: `guide` (a sentence in the system prompt), `lookups`, `moves`, `facts` (what it sees
  that matters to the owner, for a new chat's starting points).
- **Visual**: `addresses` and `reads` (a reader), `account` (where the owner's money sits there,
  what it is worth, how cash gets in and out), each move's face (`venue.md`), `problems`.
- **Roles**: `swaps`, `solana`, `bridge`, `payIn`, `tokens`, `watches`, `brain`, `wallet`,
  `channel`. One on core's money path is reviewed as core's money code is. Where the first
  answer wins, `order.ts` says who is asked first, and a new app adds its id there.
- **Its own keep**: `tables.ts`, `jobs` (each kind named `<id>:<name>`), `relayed`.
- **Settings**: declared in `about.settings`, read with `setting(about, "apiKey")`
  (`../settings.ts`), never in core's `../env.ts`. A `secret` is typed into the app through a
  private field, tried first (`tryKey`), and works with no restart, under a variable named for the app; a
  `file` setting changes whom Auni trusts, so only the settings file changes it.
- **The switch**: the owner can turn off an app they act through (`hasSwitch`). Off, Claude is
  offered none of it and it doesn't listen or watch (`offered()`); what it holds is still read
  and settled, and a move already allowed still runs (`apps()`).

## The four answers

A venue feels good when four things are right, each with a home in the folder and a check
that fails when it is skipped (`CONTRIBUTING.md` says which):

1. **Money in and out**: `account.moneyIn` and `account.moneyOut`, each one of its moves or the
   plain words the owner reads instead.
2. **Things going wrong**: `problems.ts` says each refusal the service gives in the owner's
   words, from a recorded answer; each money tool's drill (`../test/held-to-card.ts`) proves it
   signs nothing once the world moves past its card; `MayHaveSent` and `NothingMoved`
   (`../money/recipe.ts`) say what a failure left behind.
3. **How it reads**: each move's face (or the plain one core makes), `account.face`, and a
   reader for its contracts.
4. **Teaching Claude**: a `SKILL.md` named by the app's id that names every tool it gives Claude.

## Adding one

`pnpm scaffold <id> [--with <parts>]` writes an app, then runs `pnpm gen`. It passes every check
but one, which says what is left: `apps.test.ts` fails while anything Claude reads of it still
says TODO, or `order.ts` lacks a feed. With no parts it is know-how alone; `--with reads` a
reader; `--with moves,account` a venue whose account is tokens in the owner's wallet (a vault). The parts are `moves`, `account`, `reads`, `lookups`, `watches`, `wallet`,
`brain`, `channel` and `tokens`. Each is safe until written: nothing of it sends, signs, owns,
listens or prices. Then follow the guide for each part you fill: `venue.md` (moves, an account,
a reader, a job for core), `tools.md` (lookups and cards of its own), `source.md`,
`wallet.md`, `brain.md`, `channel.md`. Real apps to copy: `aave/` (a small venue), `kyberswap/` (a reader),
`hyperliquid/` (an exchange with a ledger), `polymarket/`, `elfa/` (lookups, a watch source and
a card of its own); fakes of each kind are in `../test/second-venues/`.
