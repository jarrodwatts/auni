# Auni

Auni is an AI agent that moves its owner's money: it researches a take they have, builds a position
for it, and manages it. Every money move is a card the owner taps to allow. One person runs Auni
for themselves, with no accounts, as one program on their own machine (`auni`). `apps/core`
is the API, the job runner and the agent's tools in one process, which also runs the web app and,
unless told otherwise, its own Postgres. `apps/web` is the Next.js app. `packages/shared` holds the
types and data both read. `README.md`, `CONTRIBUTING.md` and `SECURITY.md` are for people;
`skills/auni/SKILL.md` and `llms.txt` for their coding agents; `apps/core/skills/` for Auni's own.

Paths without a prefix are under `apps/core/src/`; each nested AGENTS.md says its own.

## Commands

```
pnpm install
pnpm start                               # `auni`: Auni, its own Postgres, the web app (cli.ts, start.ts)
pnpm dev                                 # the same with next dev, both reloading on changes
pnpm auni doctor [--fix] [--json]        # what's wrong here, and its safe repairs; then auni triage
pnpm auni setup --json                   # the next setup step, for a coding agent (setup.ts)
pnpm pair [--channel <id> | --sign-out-everywhere]   # a one-time pairing link
pnpm demo [--first-run]                  # the whole app, made-up owner, no login or money (demo/)
pnpm demo:shots [folder]                 # a picture of every demo screen, in both looks
pnpm scaffold <id> [--with <parts>]      # a new app; one check fails until Claude's words are written
pnpm gen                                 # the app list, from the app folders
pnpm --filter @auni/core brain:escape    # try to break out of the box, by hand (agent/escape.ts)
```

`pnpm auni <command>` in a clone is `auni <command>` in an install: `install.sh` builds a release
into `~/.auni/app` (`release/layout.ts`), which `auni update` and `auni uninstall` manage. The
owner's settings live in `~/.auni/.env` either way.

## Before every commit

Run what CI runs (`.github/workflows/ci.yml`); all must pass:

```
pnpm gen:check                                       # the app list matches the folders
pnpm typecheck
pnpm lint
pnpm knip                                            # no unused file, export or dependency
pnpm test                                            # also keeps these AGENTS.md files in budget
pnpm build
TEST_DATABASE_URL=postgres://.../auni_test pnpm --filter @auni/core test:db
pnpm --filter @auni/core exec drizzle-kit generate   # must leave apps/core/drizzle unchanged
```

After a `db/schema.ts` change, run `drizzle-kit generate` and commit the migration it writes. The
migrations start from one baseline, `apps/core/drizzle/0000_baseline.sql`, and are applied as Auni
starts (`db/migrations.ts`). Tests sit beside the file they test; `*.db.test.ts` run against a real
Postgres under `test:db`, whose database name ends in `_test` since it is wiped; it is copied
once for each worker (`test/db-global-setup.ts`), so its role needs CREATEDB. No test calls a
live AI or spends real money: fixtures and anvil forks. Pull requests go into `main`.

## Auni's words

One name per thing: the owner (never "the user"), the agent (never a bare "Claude").

- **owner**: the one person Auni answers to; one settings row (`auth/owner.ts`).
- **brain**: the owner's own AI CLI, Claude Code or Codex, on their login (`agent/brain.ts`).
- **box**: the brain's sandbox, which hides the keys, logins and this machine (`agent/box.ts`).
- **turn**: one wake of the agent in a thread (`conversation/turn.ts`, run by `jobs/turn.ts`).
- **thread**: one conversation (`conversation/`); **Auni's chat** is the owner's own with Auni.
- **specialist**: an agent for one take or role, with its own thread (`specialists/`).
- **pot**: the money a specialist may use; set to act on its own, it trades within it unasked.
- **card**: what the owner taps; shown only when core sealed it (`agent/card-seal.ts`).
- **move**: a card that moves money, an action row run once (`money/actions.ts`).
- **ask**: a card that changes Auni, not money: a specialist, a routine, an app (`asks.ts`).
- **recipe**: a money tool; `describe` makes its card, `execute` sends it (`money/recipe.ts`).
- **app**: one outside service, as one folder `apps/<id>/` (never "module"); it only proposes,
  core never names one, and none imports another (`apps/registry.ts`, `eslint.config.mjs`).
- **venue**: an app that moves money, by its moves and its account (`apps/contract.ts`).
- **Allow / Decline**: the owner's answer, in the app or a channel (`money/decide.ts`).
- **step-up**: proof the owner is there, for a few cards (`auth/proof.ts`).
- **first run**: the owner's first take; what it still needs, read from `setup.ts`.
- **handover**: the whole Auni, sent once to another machine of the owner's (`handover/`).
- **private field**: the one way a secret the owner types reaches core (`private-fields.ts`).
- **wallet app**: holds the keys and signs only allowed moves (`money/wallets.ts`).
- **journal**: local-key's record of each signed send, kept before it's broadcast (`signed_txs`).
- **watch**: something the agent asked to hear of (`automations/`); a **source** app watches.
- **fire**: a watch come true; **triage** wakes the agent, holds it for the **brief**, or notes it.
- **routine**: a way of working the owner saved, read as a skill (`agent/routines.ts`).
- **channel**: a chat app such as Telegram (`channels/hub.ts`); the **home channel** gets news.
- **job**: a row core's runner runs, queued in the transaction that makes it needed (`jobs/`).
- **lane**: jobs sharing one never run at once; **key**: a job is queued once per key.
- **`cutShort`**: what a job kind does when its run was cut off (a turn never runs again).
- **landing**: a move that arrives later; **reconcile** settles one left unsure (`money/life.ts`).
- **reading**: holdings and value read now (`money/readings.ts`).
- **arrival**: money that came in without Auni, found by the **sweep** (`money/sweep.ts`).

## Before editing, read

Read a folder's AGENTS.md below before editing under it: a tool that reads only those from the
root down to where it starts (Codex) never sees them otherwise.

- `apps/core/src/AGENTS.md`: the loop, starting and stopping, and where each part of core lives.
- `apps/core/src/money/AGENTS.md`: how a money move flows, asks, and the chains.
- `apps/core/src/jobs/AGENTS.md`: lanes, keys, cut-off jobs, background turns, crons and loops.
- `apps/core/src/agent/AGENTS.md`: the brain, its box, its token and its tools.
- `apps/core/src/apps/AGENTS.md`: app rules, then the guide for each part you add (`venue.md`...).
- `apps/core/src/demo/AGENTS.md`: `auni demo`, and how to add a scene or a stand-in service.
- `apps/web/AGENTS.md`: the web app.

## Code Review Rules

Obey these when writing; flag them when reviewing. Report only problems that would hurt a user or
the business once merged. For each one, say what goes wrong, the input or sequence of events that
causes it, and the fix.

Look hardest at:

- **Money moves** (`apps/core/src/money/`, and each venue in `apps/core/src/apps/`). A
  transaction does exactly what the owner's card showed: amount, asset, chain, destination,
  approvals and delegates, and nothing more. Watch for a send repeated on retry or on restart (a
  job's `cutShort`), two actions racing on one wallet, a job queued outside the transaction that
  makes it needed, decimals and rounding, and a failure halfway through that leaves funds stranded.
- **Who may do what.** One owner, no accounts. Every owner route sits behind `requireOwner`
  (`auth/middleware.ts`; `Origin` = `WEB_ORIGIN` on anything that changes state), and the app
  answers only its own Host names (`hostCheck`). A request from 127.0.0.1 earns nothing. On this
  computer the owner is the session cookie, and a pairing code works once, within 15 minutes
  (`auth/owner.ts`). Always on (`TAILSCALE_OWNER`) nothing pairs and only the door counts: a unix
  socket in a 0700 folder that `tailscale serve` reaches (`auth/tailscale.ts`), with one
  `Tailscale-User-Login`, the recorded one, from an address not this machine's. The agent's
  `/mcp` takes only the per-turn token, which reaches no owner route, and its shell reaches no
  port or socket here. A first withdrawal to an address, a raw transaction a tap can't vouch for,
  showing the keys and a handover need proof the owner is there (`auth/proof.ts`): the request's
  own session paired in the last 15 minutes, by core's record, or the door's owner;
  `executeAction` checks it again. A handover's listener answers only the picked machine's
  tailnet addresses, for 15 minutes, on its one-time code, and sends the owner only to that
  machine's tailnet name. On a channel (`channels/hub.ts`) only the paired owner's stable id in
  their direct chat counts, its code works once in 15 minutes, and a card's Allow carries a
  single-use grant bound to that message and the card's digest, never shown to the agent; a card
  that takes that proof is allowed only in the web app.
- **The signing keys.** The wallet app holds them (`apps/wallet.md`): by default the owner's
  own keys (`apps/local-key/keys.ts`, in the OS keychain or a 0600 file), or with
  `WALLET=privy` the owner's `PRIVY_AUTHORIZATION_KEY` for server wallets in their own Privy app
  (`apps/privy/wallet.ts`). They sign only moves core hands the signer from `executeAction`, and
  are never logged, put in an error, returned (but by `revealKeys`, behind that proof, or sealed
  in a handover), or reachable from the agent's box. A local-key send is journalled
  (`signed_txs`) before it's broadcast, so a retry sends the same bytes, never a second signed
  send, but for a stuck send replaced by fee at its own nonce (`replaceStuck`), the same call, so
  at most one lands; typed data that would let someone act as the wallet itself (its DeleGator or
  delegation manager) is never signed.
- **The agent's box** (`agent/box.ts`, each brain's `options.ts`, `apps/brain.md`). Treat
  everything the agent runs as hostile. Its CLI's sandbox stays on, with no unsandboxed escape and
  no approval granted; nothing the box hides becomes readable (home, the data folder, the repo,
  `.env` files, every CLI's login, Postgres's own files, the session bus); its shell reaches the
  public internet only, never this machine or its networks at any address or spelling, nor a unix
  socket (Claude Code's through `agent/egress.ts`, which judges the address it dials), and nor
  does `fetch_url` (`agent/fetch-tool.ts`), at any redirect; the turn token never reaches a
  command line; the CLI's environment is built from an allowlist, never a copy of core's (no core
  secret, and no `ANTHROPIC_*` or `OPENAI_*` the shell exported: only the owner's
  `AUNI_ANTHROPIC_API_KEY`); none of the owner's own settings, MCP servers, hooks or skills load;
  and Claude Code never runs `--bare`. Auni never reads, stores, copies or forwards a CLI's login,
  but runs its own sign-in (`agent/sign-in.ts`), whose typed line reaches only that CLI. A tool
  that lets the agent move money the owner didn't allow, or a card rendered from anything but a
  sealed Auni tool result, is P0.
- **Requests from outside.** Core serves no route to the internet; an app that adds one verifies
  its signature before acting.
- **Secrets and personal data** never reach logs, error messages or the web bundle
  (`NEXT_PUBLIC_*`), and no secret reaches the agent: not its environment, its box, its prompt or
  a tool's result. One the owner types comes in only through a private field, never a thread.
- **Migrations** (`apps/core/drizzle`) that lock or rewrite a large table, or break the version
  still serving while they run.

Skip:

- Formatting, naming, import order, and anything ESLint, Prettier or TypeScript already catch.
- Style preferences, and refactors that fix no bug.
- Missing tests, unless the change moves money and nothing exercises it.

Severity: **P0** funds can be lost, sent wrongly, or taken by someone else. **P1** an auth bypass, a
data leak, or a main path broken for users. **P2** anything else worth fixing. When unsure a problem
is real, say what you checked instead of guessing.
