# Adding a watch source

A source watches the world for one kind of thing ("NVDA drops below $180", "bearish news on ETH")
and says when a watch's condition came true. The hub (`../automations/`) keeps everything else:
each watch's row, recording each fire once, judging whether it wakes the watch's thread (triage),
and the rules that keep that calm. A source never touches the database.

```
  the agent's watch tool          a source app                    the hub (automations/)
  (built from every source's      ---------------                    ----------------------
   guide + condition schema)  ->  check(condition)?           ->     stores the watch
                                  remote.watch(spec)?  (leased)      renews leases, expires watches
                                  run(context)         yields fires  records each fire once, then
                                                                     saves the run's cursor; folds a
                                                                     story, holds to the cooldown and
                                                                     the day's cap; triage judges the
                                                                     rest, and may wake the thread
```

A source is a `Source` (`contract.ts`, which documents every field). `pnpm scaffold <id> --with watches`
writes one to start from: a poll that finds nothing, and stays off (`configured()` false) until its
TODOs are written. Or copy the one closest to yours:

- `clock/` is the smallest whole one: it needs nothing but this machine, works out each watch's
  next time from its schedule (core's `automations/schedule.ts`, which the brief's schedule
  shares, pure and tested on its own), and keeps in its
  cursor the last time it told each watch, so a time missed while Auni was off is found again.
- `prices/` runs on this machine: `run` keeps Hyperliquid's price websocket open, checks every
  watch's condition on each tick (`evaluate.ts`, pure and tested on its own), and after a sleep
  walks the candles it missed so a crossing fires once, `late`.
- `elfa/watch.ts` is a service that evaluates conditions itself: `remote` leases one of its
  queries per watch, and its fires come over its stream in `run`, which catches up on each query's
  fires since its cursor when it opens again.

## What a source gives

- `guide`: plain words for the agent: what it can watch, how to write a condition, what each
  costs. The watch tool's description carries it with the condition's JSON Schema, so say what the
  schema can't (which names it knows, how fast it notices).
- `condition`: a zod schema. Its JSON Schema is what the agent writes to, and the hub stores
  exactly what it parsed.
- `configured()`: it has its key. Until then the agent isn't offered it.
- `check(condition)`, optional: throw `WatchRefused` for what the shape can't refuse (a market the
  service doesn't list). Its message reaches the agent, which reshapes and retries.
- `recurs(condition)`, optional: true for a condition that comes true again and again by itself
  (a schedule), so its watch keeps firing unless the agent gives a cooldown.
- `alwaysWakes`, optional: its fires are times the owner asked to be woken at (the clock's), so
  each wakes its thread unjudged, at any hour, past the day's cap. A watch on the world leaves it
  out: judging its noise is triage's job.
- `run(context)`: how its fires arrive. An async generator, running until `context.signal`
  aborts. `context.watches()` is the list as it stands now (read it again each time; the hub reads
  it again the moment a watch starts or changes, and every few seconds besides).
  `context.refresh()` reads it from the database now, for a fire naming a watch the list doesn't
  hold yet. Yield batches of `{ fires, cursor }`: the hub records the fires, then saves the cursor,
  so a crash in between only tells a fire again, and it is recorded once. A batch with no fires
  marks progress. The next run gets that `cursor` and `since` (when it was saved): catch up on what
  happened since, and mark those fires `late`. The hub runs it inside the job runner (`sourcesJob`
  in `../automations/sources.ts`), so only the Auni holding the runner's lock watches; a run that
  ends or throws is started again after a pause, and a sleep or a stop aborts it, the cron starting
  it again on wake.
- `remote`, optional, for a service that evaluates conditions itself: `watch(spec)` returns the
  service's `ref` and when the lease ends (`until`); the hub renews it a day ahead (the 6-hourly
  `automation-renew` job, `../automations/renew.ts`), replaces one `watching(ref)` says stopped,
  and calls `unwatch(ref)` on pause, delete and expiry. Throw `OutOfCredits` when the account can't
  pay; the watch waits and is tried again.
- A fire is `{ watchId, id, at, report, story?, late? }`. `id` is unique among that watch's fires
  (the service's delivery id, or the watch and the moment), and the same however the fire is told
  again: live, caught up after a restart, or told twice. The hub's dedupe and the wake's own key
  rest on it, so a fire caught up from coarser data (prices' minute candles) takes an id at that
  grain live too. `report` is data the agent reads
  fenced, never as instructions. `story` groups reports of one story, which wake the thread once.
- `about.watchIcon` (`chart`, `clock`, `news`, `search` or `wallet`) is the icon beside its watches in the
  app.

## What the hub decides, so a source doesn't

- A one-shot watch ends on its first fire; one with `repeat` speaks at most once per its cooldown,
  once per story, and within the owner's daily cap (`DAILY_AUTOMATION_WAKES`). Fires held back are
  still recorded, as `quiet`.
- Triage (`../automations/triage.ts`): the rest of a thread's fires (but a source's that
  `alwaysWakes`) are judged together, after
  15 quiet seconds, by the active brain's fast model, from each watch's note, the report, the
  owner's largest holdings and the watch's last verdicts. Each gets a verdict and a one-line
  reason: `wake` (those share one turn now), `brief` (held for the owner's daily brief,
  `../automations/brief.ts`, when they have one; turning the brief off hands them back to triage)
  or `note`. A brain that fails or isn't ready wakes for all of them, as before triage. The turn
  may still `settle_quietly`. Triage's reasons, like the reports, reach a model only fenced as
  data: a model wrote them after reading a report.
- A fire for a watch that isn't this source's, or isn't active, is dropped.
- Expiry: a watch past `expiresAt` ends, whatever the source says.
