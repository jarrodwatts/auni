# Adding a brain

A brain is the owner's own AI CLI, run on this machine with their own login: it takes core's
system prompt and the thread so far, thinks, calls Auni's tools, and streams what it does. Auni
never reads, stores or forwards the login; the CLI uses it as it would in the owner's terminal.
The one thing Auni does with a login is start the CLI's own sign-in, from the web app on any
device (`signIn`, below), whose typed line reaches only that CLI.
There is no cloud VM and no model relay: core spawns the CLI as a child process, per turn.

```
conversation/turn.ts -> agent/brain.ts pickBrain() -> <id>.brain.run(turn, signal)
                                                        | spawns the CLI here, in the box
                                                        | Auni's tools: core's MCP at 127.0.0.1 (turn token)
                        agent/translate.ts <- BrainEvents (contract.ts)
                          checks card seals, makes the web's chunks
```

Core picks the first brain whose `check()` is ready: the one `BRAIN` names first, then the rest
in the order `order.ts` gives (Claude Code, then Codex), which `auni doctor` and each brain's
sheet say in one sentence (`whichBrainSays`). A `limit` rests a brain until its plan resets (or an hour),
and the owner is told when and what answers next; a resting brain waits behind any other that is
ready. The two real ones are `claude-code/` (the Claude Agent SDK, which runs the Claude Code it
bundles) and `codex/` (JSON-RPC to `codex app-server`).

## Adding one

1. Make `<id>/about.ts` with the name the owner reads ("Codex has reached its usage limit until
   3:40 PM") and `<id>/index.ts`, as `codex/index.ts` does:

   ```ts
   export default defineApp({
     about,
     brain: {
       check, // check.ts
       run, // run.ts
       secrets, // check.ts
       signIn, // sign-in.ts
       install, // install.ts, when Auni can install the CLI itself
       computer: "a read-only sandboxed shell on the owner's own computer, with web search; …",
       models: "OpenAI's GPT models",
     },
   });
   ```

2. Write the contract below, copying the files of whichever example is closer: a CLI with an SDK
   (`claude-code/`) or one you speak to over stdio (`codex/`, `codex/app-server.ts`).
3. Lock it in the box (below), pin its options in `options.test.ts`, and prove the box with the
   escape run.
4. Record its fixtures and replay them in `events.test.ts`.
5. Add its id to `brain` in `order.ts` (where it stands among the others), run `pnpm gen` and
   the checks in the root `AGENTS.md`. `BRAIN=<id>` tries it first.

## The contract (`contract.ts`)

- `check(signal)`: is the CLI installed and logged in here? It costs nothing (no model call), so it
  sees only that a login is there: before the running Auni calls a ready brain ready, it asks it one
  tiny question (`run`, fast role, no tools), once and again after a login is refused; a one-off
  command (`auni doctor`, `auni setup`) never calls a model (`proveLogins`, `agent/brain.ts`). Ready
  gives the login as the owner knows it ("your Claude Max subscription") and, when the CLI names
  one, `signedInAs` (an email, for the owner's screens alone); not ready gives `why`
  (`not-installed`, `signed-out`, or `broken`) and the command the owner runs themselves
  (`claude auth login`, `codex login --device-auth`). Setup's first step shows one row per brain
  from these (`brainRows`). Core keeps a ready answer five minutes and a not-ready one half a
  minute (three seconds for setup, so a fresh login turns its row ready at once), gives up on a
  check after 20 seconds and aborts `signal`, which must stop the CLI (that, or a throw, is
  `broken`, kept five minutes, as each try costs whoever asks the 20 seconds), and prints the
  answer when the API starts.
- `run(turn, signal)`: one turn, as `BrainEvent`s: `ready` (model, and where the credential
  actually came from), `text` and `thinking` deltas, `tool-call` and `tool-result`, `limit`
  (the plan is out until a time), `refused` (the login was refused: the `why` and `fix` check
  would give, shown until the brain answers again), and exactly one `done` or `error` at the end. Stop when
  `signal` aborts. Name Auni's tools by their bare names and the CLI's own as the web shows them
  (`Bash`, `Read`, `WebSearch`, `WebFetch`). A `tool-result`'s output is the tool's structured
  result when it has one (it carries the sealed card), otherwise its text.
- `secrets()`: the folders and files holding the CLI's login (`$CLAUDE_CONFIG_DIR` or
  `~/.claude` and `~/.claude.json`; `$CODEX_HOME` or `~/.codex`). Every brain's box hides every
  brain's.
- `terminal(prompt, hidden)`: the command that opens the CLI in the owner's own terminal on their
  own login and settings, for `auni triage` (`../triage.ts`), never a turn: denied `hidden` (the
  data folder's secrets) and asking before it changes anything, where the CLI can hold itself to
  that (Claude Code's permission rules, Codex's read-only sandbox profile). Null where it isn't
  installed.
- `signIn(attempt)` (optional): the CLI's own sign-in, which `../agent/sign-in.ts` runs when the
  owner taps Sign in on any device, and shows on every one. Show either a page and the code to
  enter there (`codex/sign-in.ts`: Codex's device code, from its app server), or the CLI's own
  prompt as a terminal, with a line the owner types going to `onTyped`'s writer and nowhere else
  (`claude-code/sign-in.ts`: `claude auth login` speaks plain lines with no terminal attached, so
  pipes do, and it echoes nothing). The CLI keeps the login in its own store. Resolve when it says
  it is done, reject with its own words; core checks again after.
- `install(signal)` (optional): put the CLI into Auni's tools folder (`toolsDir()` in
  `../data-dir.ts`, beside the data folder so a box can open it), where its `check` and `run` find
  it after the PATH (`codex/install.ts`). Leave it out when what is missing is the owner's to
  install (Claude Code's sandbox needs `sudo`; Claude Code itself is bundled).
- `computer` and `models`: the system prompt's words for what the agent's computer can do on this
  brain (a shell with or without the internet) and whose models think (`../agent/prompt.ts`), so
  the agent never claims a shell it lacks.

`turn.role` is deep, everyday or fast, and `turn.model` / `turn.effort` override it when the owner
picks a specific model and thinking effort for a thread (or as their default). Claude Code maps
roles to model aliases (opus, sonnet, haiku); Codex maps each to a reasoning effort or explicit
model. `turn.mcp` is null for a turn with no tools at all (`askFast` in `../agent/brain.ts`, as
triage of a watch's fires asks), which also sets `outputSchema` and expects `done.output` to be the
parsed object.

## The box (`../agent/box.ts`)

The agent does whatever what it reads tells it to, so its own tools must not reach the wallet
keys, the database, the owner's session or a login. Enforce `turn.box` with the CLI's own
sandbox:

- Nothing under `hidden` is readable: home, the data folder (and its keys file), the repo, every
  brain's login, Postgres's own files (`databaseFiles` in `../db/client.ts`), and the session bus
  (`/run/user/<uid>`, the door to the OS keychain and the ssh agent). `workDir` is its one scratch
  folder, beside the data folder rather than in it, and `readable` never holds a path in the data
  folder (an install's private Node is there, so its shell gets no Node), so the data folder hides
  whole.
- No unsandboxed escape: no command the agent runs leaves the sandbox, and no approval it asks
  for is granted, since no one is there to answer.
- Its shell reaches no unix socket, and nothing on this machine or its networks: not core,
  Postgres, the LAN or a tailnet, at any address or spelling (127.0.0.2, 2130706434, the
  machine's LAN address). A list of names can't promise that, so a shell with the internet gets it
  only through `../agent/egress.ts`, which judges the address it dials; one without needs none.
  No tool the CLI runs outside its sandbox may fetch (Claude Code's WebFetch is left out).
- A child environment built from an allowlist, never a copy of core's, which holds the database
  URL, the turn token's secret and whatever the owner's shell exported (an `ANTHROPIC_BASE_URL`
  would send the owner's turns somewhere other than their own login).
- None of the owner's own settings, MCP servers, hooks, skills or memories.

Only Auni's tools, run in core over MCP, do anything that matters.

Each CLI's sandbox does this its own way:

|                | `claude-code/options.ts`                                        | `codex/options.ts`                                              |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Sandbox        | Claude Code's: on, `failIfUnavailable`, no unsandboxed commands | Codex's `:read-only` permissions, `approval_policy="never"`     |
| Hidden folders | `denyRead`, with `readable` reopened inside                     | denied entry by entry, since 0.164 can't reopen inside a denial |
| File reader    | `Read` only in `workDir`, by permission rule (it runs outside)  | none: every read goes through the sandboxed shell               |
| Shell network  | the public internet only, through Auni's egress proxy           | none at all (`fetch_url` reads public pages and APIs)           |
| Auni's token   | in a 0600 file in the data folder (`--mcp-config <file>`)       | an environment variable the app-server reads, not the shell     |
| Owner's setup  | `settingSources: []`, `strictMcpConfig`, no skills              | `-c` flags turn features off; `config/read` disables their MCP  |
| Never          | `--bare` (it ignores the subscription login)                    | `--startup-sign-out` (it signs the owner out)                   |

Codex always adds the owner's own `$CODEX_HOME/AGENTS.md` to a thread; `codex/run.ts` says so
once, and `apps/core/.env.example` says how to keep it out.

## What stays in core

Cards: `../agent/translate.ts` renders one only when core sealed it and an Auni
tool returned it, so nothing the CLI prints or writes can show a card. The prompt
(`../agent/prompt.ts`), skills (the `load_skill` tool, `../agent/skills.ts`), chain reads
(`read_chain`, `../money/read-chain.ts`) and public pages and APIs (`fetch_url`,
`../agent/fetch-tool.ts`, which dials only what `../agent/egress.ts` judges public) reach every
brain the same way, as MCP tools, so a skill names `fetch_url` rather than a shell's `curl`.
The turn token never goes on a command line, where any process of the owner's could read it.

What only one CLI needs stays in its app: Claude Code's Stop hook, which won't let a turn
that asked with `suggest_replies` end before it wrote a reply (`claude-code/run.ts`), and the one
nudge Codex gets when it ends a turn with no reply at all (`codex/run.ts`).

## Fixtures and the escape run

Each app splits the CLI's process (`run.ts`, `check.ts`) from a pure function of its raw frames
(`events.ts`), so tests replay recorded frames and none calls a live AI. `record.ts` records a real
turn into `fixtures/<scenario>.jsonl` (by hand: it spends the owner's plan). Fixtures are
committed, so the recorder keeps only what the replay reads: it redacts the turn token, home and
account ids (`redactor`), and cuts any frame carrying the owner's own setup (their config, model
catalogue, skills or commands) down to the fields `run.ts` and `events.ts` use. The scenarios are the
same for every brain (`../agent/live.ts`): `card` (a sealed card), `skill` (load_skill) and `triage`
(structured output); Claude Code also keeps `routine`, a thread asking on a card to save a routine.
A `limit` fixture is written by hand from the CLI's types
and named `limit.synthetic.jsonl`, and `signed-out` replays a refused login (Claude Code's
recorded with a made-up key). Record with
`TEST_DATABASE_URL=postgres://…/<name>_test pnpm --filter @auni/core exec node src/apps/<id>/record.ts <scenario>`.

Prove the box with a real adversarial turn, by hand:
`TEST_DATABASE_URL=postgres://…/<name>_test pnpm --filter @auni/core brain:escape <id> [--offline]`
(`../agent/escape.ts`). It plants a canary and stand-in keys in a throwaway data folder, has the
agent try to read them, the repo's `.env`, the logins, core's port, the database socket and a
service listening on every address of this machine (at 127.0.0.2, as a number, and at its LAN and
tailnet addresses), and fails if any secret shows up in the stream, the waiting card moved or that
service answered. `--offline` is for a brain
whose shell has no network (Codex): the public internet must then not answer.
