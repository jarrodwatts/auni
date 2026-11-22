---
name: auni
description: Set up, run, fix and extend Auni, the open-source AI money agent a person runs on their own machine with their own AI login and their own wallet. Use when someone asks to set up or install Auni, start it, pair their browser, bring their wallet keys, find out why it isn't working, or change or add to it (a venue, a lookup, a watch source, a wallet, a brain, a chat app), or when you are working in the Auni repository.
license: MIT
compatibility: For coding agents with a terminal (Claude Code, Codex and the like), on Linux, macOS or WSL. The installer brings its own Node; Auni runs its own Postgres.
---

# Auni

Auni is an AI agent for the person's own money. It runs on their machine, thinks with their own
Claude Code or Codex login, and every money move is a card they tap to allow in their browser.
Nobody operates it for them: no accounts, no fees, no token.

You are helping them set it up or change it. You are not Auni, and you never move their money.

## Rules that keep their money safe

- **Never handle a secret.** Never ask for, read out, print or paste a private key, seed phrase,
  wallet export, login token or pairing link. Keys go in only in the browser, through a field
  whose value goes straight to Auni on their machine: tell them to bring them there. `auni` opens
  the pairing link in their browser and never prints it; only `auni pair` prints one, for them.
- **Never log in for them.** They sign their AI in themselves: in the browser setup wizard,
  under **Settings → AI Brains**, or with `claude auth login` or `codex login --device-auth` in a
  terminal of their own.
- **Never open Auni to the network.** Core and the web app listen on 127.0.0.1 only. Don't set
  `HOST` or `WEB_HOST`, or tunnel a port, unless they ask and understand anyone on that network
  could reach their money's controls. To reach it from their phone, `auni up --always-on` on a
  machine that stays on, signed in to their Tailscale (`--json` says each step, and the one
  `sudo` command for them to run); never point `tailscale serve` or a tunnel at its ports
  yourself. A server is `hosts/`'s recipes, with HTTPS in front.
- **Never weaken the box or the card checks** (`apps/core/src/agent/box.ts`,
  `apps/core/src/money/approved.ts`, `apps/core/src/agent/card-seal.ts`) to make something work.
  If a change seems to need it, stop and explain.
- **Never spend real money to test.** Tests use fixtures and anvil forks. A live proof of a new
  venue is the person's own call, at most $25.

## Setting it up

1. **Tools.** Auni runs on Linux and macOS. On Windows, Auni and every step below run inside
   WSL: if you are running on Windows itself, stop, and have the person run `wsl --install` in
   PowerShell as administrator (restarting if it asks), open the Ubuntu terminal it adds, install
   you there, and ask you again from inside it. The installer needs only `curl` and `tar`.
2. **Install.** Run
   `curl -fsSL https://raw.githubusercontent.com/jarrodwatts/auni/main/install.sh | sh`. It builds
   Auni from source into `~/.auni/app` (a few minutes) and puts the `auni` command in
   `~/.local/bin`; when that folder isn't on the PATH, use `~/.local/bin/auni` below and tell the
   person the PATH line it printed.
3. **Follow setup.** Run `auni setup --json` and do what its `next` says, then run it again,
   until it says `stop`. Each run works out the next step from what is really on this machine, so
   running it again is always safe.

Each answer is JSON: `step`, `next`, `say` (plain words written to the person, as "you": pass
them on as they are), and per `next`:

| `next` | What you do                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| `run`  | Run `run.command` (in the background when `run.background` is true), wait `waitSeconds`, then run setup again.     |
| `tell` | Tell the person `say`; it may name a command for them to run themselves. Wait `waitSeconds`, then run setup again. |
| `wait` | Wait `waitSeconds`, then run setup again.                                                                          |
| `stop` | Tell the person `say`. Setup is done, or needs something only they can change.                                     |

The steps, in order, and what each one waits on:

- **tools**: Linux, macOS or WSL. On Windows itself it stops and says how to start inside WSL.
- **install**: Auni installed (or a clone). When `~/.local/bin` isn't on the PATH, the commands it
  gives use `~/.local/bin/auni`, and `say` names the line for their shell's profile.
- **brain**: Claude Code or Codex logged in on this machine. Setup names each one's commands; the
  person runs them.
- **start**: Auni running (`auni`, in the background). Setup then says what it did: opened their
  browser, signed in as theirs, or couldn't (no screen here, as over ssh), when they run
  `auni pair` themselves and open its link, and setup names the ssh line that brings it to their
  own computer. Never run `auni pair` for them or read a pairing link. It runs while your session
  does; `auni service install` keeps it running for good, if they want that. `auni stop` stops
  it, whatever started it (you, a terminal, the service), letting moves in flight finish first:
  it can take up to two and a half minutes, so give it that long, and run it again to keep
  waiting (asking twice never cuts anything short).
- **done**: setup hands over. The browser opens on the skippable setup wizard (AI Brain → Wallet →
  optional X handle, watch-only wallets, Telegram & Tailscale) and lands in a clean chat with
  tailored starting prompts. Your part is over; `auni doctor` (or **Settings → Diagnostics**)
  checks it any time.

If setup exits non-zero, show the person its message, then see "When something's wrong" below.

Optional extras, only if they want them, such as Telegram or a key for Elfa's news watches:
`README.md` says how to add each. A key is theirs to paste into its app under Apps, in the web
app, where it works at once: never ask them for it. Every other setting goes in `~/.auni/.env`
(`apps/core/.env.example` lists them all) and takes effect on the next start (`auni stop`, then
start it as before). `auni update` checks a newer release, says what changed and that it stops
the running Auni, and asks; show the person what it says, and run `auni update --yes` only once
they say to. It stops Auni itself, rolls back by itself if the new version doesn't come up, and
then starts Auni again as it ran (the service, or in the background, its output in
`~/.auni/auni.log`), so the web app comes back on its own: don't start it again yourself.
`auni uninstall` asks the same way (`--yes`) and stops Auni first. It keeps the wallet's keys,
and says where they are: only the person, typing it in their own terminal, removes them.

## Changing it

Work in a clone (`git clone https://github.com/jarrodwatts/auni`, Node 24, `corepack enable`,
`pnpm install`), where `pnpm auni <command>` is `auni <command>`. Read `AGENTS.md` first: Auni's
words, the checks, and which folder's own `AGENTS.md` to read before editing there. Then:

- **A new app.** Each outside service is one folder, `apps/core/src/apps/<id>/`, and core finds
  it without being edited. Read `apps/core/src/apps/AGENTS.md` first, then pick the smallest of
  three sizes that does the job; each is finished at its size:
  - **Know-how** (Claude should stop rediscovering how a service works): `pnpm scaffold <id>`,
    then write its `SKILL.md`: when to load it, and the steps that work there.
  - **A reader** (a transaction Claude builds for it should read as a real card, under its
    name): `pnpm scaffold <id> --with reads`, then say which contracts are its own (`addresses`)
    and write `reads`. It changes no figure on the card. Copy `apps/core/src/apps/kyberswap/`.
  - **A venue** (something a bare transaction can't do, such as an exchange order):
    `pnpm scaffold <id> --with moves,account`, then each money tool with its drill, its
    account, and its `problems.ts`. Copy `apps/core/src/apps/aave/`; `CONTRIBUTING.md` says what a
    venue answers for.

  An app can also do a job for Auni itself: `--with lookups`, `watches`, `wallet`, `brain`,
  `channel` or `tokens` (a price feed). Follow the guide beside the apps for each part you fill.
  Nothing outside the folder changes but what `pnpm gen` writes, with one exception: a bridge,
  a pay-in, a Solana route or a token feed adds its id to `apps/core/src/apps/order.ts`, which
  says who is asked first. What `pnpm scaffold` writes fails exactly one check until it is
  finished, and that check says what is left.

- **What Auni says or knows:** `apps/core/src/agent/prompt.ts` and `apps/core/skills/*/SKILL.md`.
- **Before saying it's done,** run every check under "Before every commit" in `AGENTS.md` and make
  them pass.

## When something's wrong

- **Anything at all**: start with `auni doctor`, which checks the version, the database, the
  jobs, the service, each chain's RPC, the brain, the wallet and the web app. Act on every `fix`
  line it prints. Where a safe repair exists (starting or restarting the service, starting it at
  boot) it lists it: `auni doctor --dry-run` shows them, and `auni doctor --fix` runs the
  recommended ones once the person says yes. None touches keys or money.
- **Still stuck**: follow `triage.md` beside this file, the playbook `auni triage` starts the
  person's own Claude Code or Codex with. Run `auni triage` first (it writes the facts it reads
  and says where), or have them run it in their terminal.
- **"Auni has nothing to think with yet"**: no brain is logged in; it lists the commands to run.
- **"Auni is already running"**: another `auni` has this database, and it opened that one; it
  says how that one runs (in a terminal, in the background, as a service). `auni stop` stops it,
  whatever started it; `auni service uninstall` removes the service for good.
- **Turns never start, or watches never fire**: `auni doctor`'s jobs line says whether the job
  runner is running and what is late or failed.
- **A card failed**: its message says why; nothing moved unless the card says it may have. Read the
  thread before suggesting the person try again.
