# Contributing to Auni

Thanks for helping. Auni moves people's money, so the bar is high in a few places and low
everywhere else: a small, clear change with a test is always welcome.

Start with `AGENTS.md` (written for coding agents, and just as useful to people): Auni's words,
the checks every change must pass, and the rules a review holds it to. Each area's own `AGENTS.md`,
beside its code, says the rest: the one loop, how a money move flows, the jobs, the agent's box.

## The rules that don't bend

1. **Apps only propose.** Core decides, and the wallet signs only moves the owner allowed, each
   still matching its card when it runs.
2. **A card means what it says.** A transaction does exactly what its card showed: amount, asset,
   chain, destination, approvals, and nothing more.
3. **No secret reaches the agent.** Keys, logins and the database stay out of the agent's box, out
   of logs and out of errors.
4. **No test calls a live AI or spends real money.** Record real answers as fixtures. What only a
   real chain can show (how the wallet's sends land) runs against an anvil fork, as
   `apps/core/src/apps/local-key/evm.fork.db.test.ts` does.
5. **Simple beats clever.** Delete rather than add. A contract only where two real
   implementations need one. A comment says why, not what, and describes the code as it is: no
   history ("used to", "before X"), and no branch for older data, which the migrations' baseline
   refuses. One name per thing: the owner, the agent, a card, a move (`AGENTS.md`'s "Auni's
   words").

## Making a change

```
pnpm install
pnpm dev                                        # core and the web app, both reloading on changes
```

`pnpm dev` runs Auni as `pnpm start` does, its own Postgres included, but with `next dev` for the
web app; `pnpm pair` prints the link that pairs your browser. A clone keeps its data and settings
in `~/.auni` (`~/.auni/.env`) like an install; set `AUNI_HOME` to keep one apart, whose wallet's
keys stay in that folder, never the OS keychain, so deleting it leaves nothing behind. People install
Auni with `install.sh`, which builds a signed release from source (`RELEASING.md` says what a
release is and how one is made); CI installs each commit that way on Linux and macOS. Before you commit, run every check under "Before every commit" in `AGENTS.md`; CI runs
the same on every pull request, and all must pass. Open the pull request against `main`, say what
it changes and why in plain words, and say how you proved it.

To look at the app without a login, a wallet or money, run `pnpm demo`: the real app with a
made-up owner, a scripted AI and stand-in chains, the same every time (`apps/core/src/demo/`).
Its new chat offers a tour: ten minutes of tapping through everything Auni does.
`pnpm demo:shots before/` takes a picture of every screen at desktop and phone width, in the
light look and (in `before/dark/`) the dark one; run it
before and after a change to the web app and compare the two folders. The demo's clock is stopped
for the pictures, so two runs of one build give the same files, and a file that differs shows
what your change did.

## Adding an app

Each outside service is one folder, an **app**, in `apps/core/src/apps/<id>/`, and core finds it
without being edited: `pnpm gen` writes the lists that wire it in. An app is a layer over what
Claude can already do (build any transaction, which core simulates and shows as a card): it
teaches Claude the service, makes what happens there read well, and can do what a bare
transaction can't. It comes in three sizes, each finished at its size:

| Size     | In the folder               | Start it with                             |
| -------- | --------------------------- | ----------------------------------------- |
| Know-how | a `SKILL.md`                | `pnpm scaffold <id>`                      |
| Reader   | plus the contracts it reads | `pnpm scaffold <id> --with reads`         |
| Venue    | plus moves and an account   | `pnpm scaffold <id> --with moves,account` |

An app can also bring a look (`pnpm scaffold <id> --with theme`): a `theme.css` that gives
Auni's design tokens (`apps/web/app/tokens.css`) other values under its own selector, which
the owner picks in Settings, under Look, beside Auni's own light and dark. It may do nothing
else (`apps/core/src/apps/theme.ts` holds it to that). Every colour in the web app comes from
one of those tokens (`apps/web/app/tokens.test.ts` fails one written into a component), so a
look reaches all of it. No app's look ships yet.

An app can also do a job for Auni itself: lookups, a watch source, a wallet, a brain, a chat
app, a token feed, a swap route, a bridge or a pay-in (`--with lookups`, `watches`, `wallet`,
`brain`, `channel`, `tokens`). Where the first answer wins (a bridge, a pay-in, a Solana route,
a token feed), who is asked first is written in `apps/core/src/apps/order.ts`, and such an app
adds its id to the end of its role's list: the one line outside its folder, since who Auni
believes first about a price isn't for a folder to decide by its name. What `pnpm scaffold`
writes is safe and does nothing until its TODOs are written, and passes every check but one:
`apps.test.ts` fails while anything Claude reads (its `SKILL.md`, a guide, a tool's
description) still says TODO, or while a feed isn't in `order.ts`, so an unfinished app can't
merge looking finished. `apps/core/src/apps/AGENTS.md` is the page to read first: the idea, the
folder, the parts, and a guide for each part.

## What an app answers for

A service feels good in Auni when four things are right. Each has a home in the app's folder,
and a check that fails when it is skipped:

1. **Money in and out.** Its account says how money gets there and how it comes back to the
   owner's wallet: a move of its own, or plain words when there is none. `apps.test.ts` fails an
   app with moves and no account, and an account whose way in or out is neither.
2. **Things going wrong.** Each money tool has a drill (`apps/core/src/test/held-to-card.ts`) that
   proves what it signs is exactly what its card showed, and that it refuses, sending nothing,
   once the price moves, once it would take more, or once it would pay somewhere else; the drill
   stands in for the service and the chain. `money/held-to-card.test.ts` fails a money tool
   with no drill. And its `problems.ts` says each refusal the service gives as the owner should
   read it, each with the service's answer saved as a fixture: `apps.test.ts` fails an app with
   moves and no such table, and a row that no longer matches its own recorded answer.
3. **How it reads.** A move may write its own card's words (its face), or read as the plain card
   core makes from its sentence and what the simulation saw. Its holdings say how they read in
   the portfolio, and a reader names the transactions Claude builds for its contracts. The drill
   fails a face that types dollars of its own in place of `AMOUNT`; the type requires each
   holding's face. Nothing can check that the words read well: the reviewer reads them.
4. **Teaching Claude.** Its `SKILL.md` says when to load it and the steps that work, and names
   every tool it gives Claude. `apps.test.ts` fails a skill that misses a tool, and anything
   Claude reads that still says TODO.

An app that can't answer at the size it claims is merged at a smaller one (a reader instead of a
venue, know-how instead of a reader), or waits in its pull request. A part that does a job in
core's own money path (a swap route, a bridge, a pay-in, a token feed, a wallet) is reviewed as
core's money code is,
and a wallet's signer and a brain's box get the closest review in the repo. A channel must pass
the same self-approval table as Telegram (`apps/core/src/apps/channel.md`). Someone who answers
for an app when it breaks (for a venue, ideally someone at the service itself) is named by
GitHub handle in its `about.ts` `maintainers`, and `pnpm gen` writes them into
`.github/CODEOWNERS`, so they review every change to its folder.

## Pull requests written by agents

Welcome. Most of Auni was written with coding agents, and we'd expect yours to be. A few asks:

- **A person answers for it.** You opened it, so you've read it, and you can explain any line.
- **It passes the checks**, and the description says how it was proved, not just what changed.
- **Small and focused.** One change per pull request. A sprawling one is closed with a request to
  split it.
- **At most three open at a time per person.** Land or close one before opening the fourth.

## Security problems

Never in a public issue. `SECURITY.md` says how to report one privately.
