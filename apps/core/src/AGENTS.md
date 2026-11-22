# Core

Paths are under `apps/core/src/`.

## The one loop

An event wakes the agent in a thread, the agent thinks, its tools propose cards, and an allowed card
is signed by the wallet and sent by the venue. The move landing is the next event.

```
  a message, a watch firing (judged first by triage), a move landing, money arriving
        v
  the turn job (jobs/turn.ts) -> runConversationTurn (conversation/turn.ts)
        |  system prompt (agent/prompt.ts) + the thread so far (conversation/history.ts)
        v
  the brain (agent/brain.ts) runs the owner's own AI CLI in its box; its events stream to
        |  each open tab over GET /live; it calls Auni's tools over MCP, which run in core
        v
  lookups answer at once          money tools record an action and return a sealed card
                                        |  the owner taps Allow, or a specialist acts on its own
                                        v
                                  the action job (jobs/action.ts) -> executeAction
                                        |  the wallet app signs, the venue's recipe sends
                                        v
                                  it lands, and the thread wakes with the result
```

The web app shows every turn. A `deliver` job queued with an answer sends it to a channel too: an
answer to a message from a channel goes back there, and one said unasked (a landing, a watch, the
brief, an arrival) goes to the home channel (`channels/home.ts`), unless the turn settled quietly.

## Starting and stopping

```
  auni (cli.ts)
     |  boot.ts: ~/.auni/.env, the turn-token secret, Postgres (DATABASE_URL's, or its own)
     v
  start.ts: migrate -> job runner (one per database) -> API :4000 -> web app :3000 -> browser
     |
  Ctrl-C / auni stop: web app stops, API takes no new requests, turns end, other jobs (a send in
     |  flight) get up to 2 minutes, then the database closes and Postgres stops
     v
  a second Ctrl-C stops at once; the wallet's journal and the next boot's job rules cover it
```

The browser opens on the pairing link while no browser is paired, else the app; the link never
reaches the output (`openOwner`). The app spends the code on load, so the browser lands signed in,
on its first take until sent; a terminal sees Auni hop its start (`hello/`), and logs go to
`auni.log`. Core and the web app listen on 127.0.0.1 only; always on (`always-on.ts`), Tailscale
reaches both through core's door. A second `auni` on one database opens the browser on the one
running, which `running.ts` names and `auni stop` stops. What Auni keeps here is in the data folder
(`data-dir.ts`), but for the wallet keys, in the OS keychain where there is one
(`apps/local-key/keys.ts`), and the agent's scratch folder and Auni's tools folder beside it.

## Where things live

- `conversation/`: threads (`send.ts`; renaming, archiving or deleting one, `tidy.ts`), the
  history a turn reads, `mainChat` (`places.ts`), live updates (`stream.ts`, `routes/live.ts`),
  the `settle_quietly` and `set_notices` tools (`tools.ts`), and a new chat's starting points
  (`starting-points.ts`), from what Auni sees (`facts.ts`).
- `agent/`: the brain, its box and Auni's MCP tools; read its AGENTS.md.
- `money/`: moves, cards, holdings, chains; read its AGENTS.md.
- `jobs/`: background work; read its AGENTS.md.
- `asks.ts`: cards that change Auni (`recordAsk`, `applyAsk`); `connect.ts` offers an app.
- `specialists/`: specialists and their rules (`specialists.ts`, `rules.ts`, `routes.ts`), their
  tools (`tools.ts`), and what a turn reads of its place (`context.ts`: `auniContext`,
  `specialistContext`).
- `automations/`: watches and their fires (`sources.ts`, `sourcesJob`), lease renewals
  (`renew.ts`), triage (`triage.ts`), the daily brief (`brief.ts`), the watch tools (`tools.ts`).
- `channels/`: the channels' hub (`hub.ts`: `channelsJob`, `deliverJob`, pairing, grants), cards
  on a channel (`cards.ts`, `draw.ts`), and the home channel (`home.ts`).
- `auth/`: the owner's pairing and session (`owner.ts`, `routes/owner.ts`), `requireOwner` and
  `hostCheck` (`middleware.ts`), the owner's proof (`proof.ts`), Tailscale's door (`tailscale.ts`),
  turn tokens.
- `server.ts` mounts the routes: `routes/`, and `money/routes.ts`. Settings are `GET /me` and
  `PATCH /me` (`routes/me.ts`), showing the keys `POST /me/keys`.
- `db/`: tables (`schema.ts`), migrations (`migrations.ts`), Auni's own Postgres (`embedded.ts`),
  and the way out of it (`export.ts`: `auni export`, `auni import`).
- `handover/`: Auni handed to another machine, and `auni take-over` there.
- `env.ts`: core's settings, read once, mirrored in `apps/core/.env.example`. `settings.ts`: the
  ones an app declares (`setting`), and the one writer of the owner's settings file: an app's
  own secret (`saveSetting`), the apps off (`saveSwitch`), the terminal's `saveAlwaysOn`.
  `app-list.ts`: how each app stands (`GET /apps`); `PATCH /apps/:id` is the switch.
- `setup.ts`: what is true of this machine, the one source for `auni setup` (`nextStep`), `auni
doctor` (`doctor.ts`, `repairs.ts`, `triage.ts`) and first run's `/setup` (`routes/setup.ts`).
  A new thing to check goes there. `service.ts` (with `hosts/`);
  `web-app.ts` (`next start`, built first whenever its source changed).
- `private-fields.ts`: a secret the owner types comes in only through a private field: core
  declares it, the web draws it, and the value goes to `routes/private.ts` and nowhere else: not
  a thread, the agent, a log, an error, a response, the URL, browser storage or a cache.
- `release/`: an install's layout (`layout.ts`), a signed release (`make.ts` makes it,
  `install.sh` checks it), `auni update` (`update.ts`), `auni uninstall`.
- `demo/`: `auni demo`, the real app with a scripted brain, a stand-in wallet and a stand-in
  for every outside service; read its AGENTS.md.
- `test/`: shared test helpers; `test/no-real-keys.ts` keeps every test off the real keychain.
