# The demo

Paths are under `apps/core/src/demo/`. `auni demo` (`pnpm demo`) is the whole of Auni, started as
`auni` starts it, with three things stood in for, so it needs no login, calls no model and moves
no money:

```
  the brain    a script that calls Auni's real tools over MCP      brain.ts, scenes.ts
  the wallet   signs for no real network, sends to a ledger here   wallet.ts
  the world    every outside API, chain and price stream           world.ts, world/
```

Everything between them is the real code: the tools, the recipes, cards, jobs, the portfolio and
the web app. Core has no demo branch. The demo reaches it through the doors anything does: an
app each for its brain and wallet (`app.ts`, in place of every real one by `standIn`),
`fetch` and `WebSocket` (`world.ts` takes both over, and refuses any host with no stand-in), a
message (`conversation/send.ts`) and a tap (`money/decide.ts`).

## It can touch nothing real

- It is a command, never a setting: nothing in a `.env` or the environment turns it on, and a
  real `auni` never loads this folder.
- `home.ts` replaces the environment before anything else loads: its home is a folder under the
  system's temporary one, and every variable but the few a program needs is dropped, so no
  `AUNI_HOME`, `DATABASE_URL`, `WALLET`, `BRAIN`, RPC or key of the owner's is read.
- Its home's name can be guessed, so what an earlier demo left there is cleared only from a plain
  folder of this person's (a link is refused), and a left `postmaster.pid` is signalled only when
  it names a postgres running on that folder.
- No real CLI is started and no key is reached: the apps that think or sign are left out, and
  `tailscale` and `gh` are the demo's own, first on its PATH, with a made-up tailnet and a star
  that reaches no GitHub account (`world/commands.ts`).
- The wallet's EVM key is printed in `wallet.ts`, so its address is nobody's.

`demo.test.ts` starts it from an environment that names all of those and checks each.

## The owner is played, not inserted

`seed.ts` makes the demo's owner as it starts by playing their past through core: money arrives
on the demo's chains and the sweep finds it, the owner's messages go in as any message does, the
brain answers with real tool calls, and each card is allowed as a tap allows it. Then each step
is dated back, onto exact times in the order its rows were written, however long it took to play. So every row is one the app wrote, and a change to a tool, a recipe or a card shows
in the demo without this folder changing. Prices are one fixed curve laid on the clock from the
start of the day the demo runs, and each step plays at the prices of its own time
(`world/prices.ts`), so two runs look the same at any hour, but for the dates and the past
week's figures.

`auni demo --at <moment>` takes those away too (`clock.ts`): the demo's clock is stood in for at
both doors core reads the time through, `Date` in this process and `now()` in its Postgres. The
owner is made in the five minutes before the moment, then the clock stops at it, so every run of
one build shows the same thing, on any day. Nothing set for later comes due on a stopped clock,
so it is for looking, not for playing a scene on.

## The tour

A demo's browser lands on a new chat, whose first starting point is the tour. The tour is a
chat (`tour.ts`): at each stop the brain says one thing to do, in Auni's own voice, and docks the
reply that does it with Auni's own `suggest_replies`, so the next step is one tap; a place to go
is a link in its words. A reply is what an owner would type, so the scene it plays is the real
one, with the tour's words around it. Where a thread stands is the last "Stop 3 of 12" the brain
said in it: the tour keeps nothing, and a person can walk off and come back. Nothing of it is outside this folder but
`landsOn`, the page a start brings the browser to (`tour.test.ts` holds that). `demo.test.ts`
walks every stop through core. A new stop is an entry in `STOPS`, and a scene for its reply.

## Adding to it

- **A scene** (something to show): add it to `scenes.ts` with what it hears and the tools it
  calls. `demo: <name>` plays it in a chat. A tool that refuses ends the scene, and the brain
  says what Auni answered. To have the owner's past hold it, say its words in `seed.ts`, and
  leave the money for it to be played again (`demo.test.ts` plays `plan` and `short` once more).
- **A service** a scene needs: one file in `world/` answering its host as the real one does, a
  line in `world/index.ts`. A contract on a chain is `chains.get(<chain>).deploy(...)`
  (`world/chain.ts`). Until it has one, a host answers as if down, and the demo's output names it.
- `pnpm demo:shots [folder] [light|dark]` (`scripts/demo-shots.ts`) takes every screen at two
  widths in both looks (the dark one into `<folder>/dark/`), each from a demo of its own, with
  the demo's clock and the browser's stopped at one moment: two runs of one build give the same
  files byte for byte, so a picture that differs is a change to the app.

`auni demo --first-run` (`first-run.ts`) is a new owner's instead: no past and no money, first
run's question, and its one take (peptides, `take` in `scenes.ts`) played through: its first
picks on one card, money sent in while the card's Add money is open, the buy, and the spare key.
With `--no-wallet` it has no wallet until that take's chat makes one, as most new owners.

Not shown yet: a Polymarket buy or its cash coming home (both need its
relayer, which has no stand-in; a sale needs only its book), a market pulse (it needs Elfa), a
Solana move, and a withdrawal to someone else's address, whose card checks it's the owner.
