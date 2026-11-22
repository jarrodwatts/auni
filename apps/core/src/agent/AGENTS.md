# The agent

Paths are under `apps/core/src/`. Before you touch `agent/box.ts`, `agent/egress.ts`,
`agent/fetch-tool.ts` or a brain's `options.ts`, read "The box" in `apps/brain.md`: what the
agent's shell and file reader get, what they can't read or reach, and how each CLI's own sandbox
enforces it. Treat everything the agent runs as hostile.

## Where the brain runs

The brain is the owner's own AI CLI, which core spawns as a child process for each turn, on this
machine and on the owner's own login (their Claude or ChatGPT plan). There is no cloud VM and no
model relay: Auni never reads, stores or forwards the login, and the CLI uses it as it would in the
owner's terminal. From the web app, on any device, Auni installs a missing CLI into its own tools
folder or starts the CLI's own sign-in (`agent/sign-in.ts`, `GET /brains`): Codex's page and code,
or Claude Code's prompt drawn as a terminal, whose typed line goes by a private field to that
prompt alone. Core picks the brain each turn (`agent/brain.ts`): the one `BRAIN` names first,
then the first of the others that is logged in. One that reaches its usage limit rests until its
plan resets; the owner is told when, and which brain answers next. `brainStatus` is what Settings
shows. Each brain is an app (`apps/claude-code/`, `apps/codex/`).

## What reaches the agent

- **One credential**: a per-turn token (`auth/turn-token.ts`, one thread while its turn runs) for
  core's MCP server (`/mcp`, `auth/turn-token-middleware.ts`), where every Auni tool runs. Claude
  Code gets it in a 0600 file in the data folder (`--mcp-config <file>`,
  `apps/claude-code/run.ts`), Codex by an environment variable its shell never inherits; never
  on a command line, where any process of the owner's could read it.
- **Its tools**: `toolsFor` in `agent/mcp.ts` decides which a turn has; money tools are
  `money/tools.ts`, specialist tools `specialists/tools.ts`, watch tools `automations/tools.ts`.
  Chain reads (`read_chain`, `money/read-chain.ts`) keep a keyed RPC URL from the agent. Every
  call's input is read by `toolInput` (`agent/tool.ts`) before its tool runs: text that plainly
  means a number, true or false, or a list is read as one, and anything else is refused saying
  what to send (`agent/input-errors.ts`), so a tool's schema says only what it takes.
- **The web**: Claude Code's shell reaches only public addresses, through Auni's egress proxy
  (`agent/egress.ts`, which judges the address it dials, not the name). Codex's shell has no
  network, so both read pages and APIs with `fetch_url` (`agent/fetch-tool.ts`), which runs in core,
  dials only what egress judged public at each redirect, sends no cookies or headers of the agent's,
  and returns what it read fenced as data.
- **Cards**: core seals each card a tool returns (`agent/card-seal.ts`), and `agent/translate.ts`,
  which turns the brain's events into the web's stream, shows a card only when an Auni tool
  returned it sealed, so nothing the agent writes can show one move and run another.
- **Secrets**: never. `request_secret` (`agent/secret-tool.ts`) asks for one by its private field's
  id; the secret saved there allows the card, and the agent is told only that. A key pasted into
  a message is kept out of the thread and the turn (`conversation/pasted-key.ts`).
- **Feedback**: `send_feedback` (`agent/feedback-tool.ts`) returns a card of what the owner could
  post to Auni's GitHub themselves: an app asked for, a bug, an idea. Core builds every part
  from its own records (`feedback.ts`), with whatever could point at the owner's wallet off
  until they tick it; `GET /feedback` (`routes/feedback.ts`) is the same for a report the owner
  starts. Nothing is sent by Auni.

## What it is told

- The system prompt, worded for the brain: `agent/prompt.ts`.
- Skills: `apps/core/skills/*/SKILL.md`, loaded with `load_skill` (`agent/skills.ts`).
- The owner's routines: `<dataDir>/routines/<name>/SKILL.md`, read fresh into `load_skill`
  (`agent/routines.ts`); saved only by a `save_routine` ask (`agent/routine-tool.ts`, `asks.ts`).

Prove the box by hand with `pnpm --filter @auni/core brain:escape` (`agent/escape.ts`).
