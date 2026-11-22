# Jobs

Paths are under `apps/core/src/`. Background work is rows in Postgres (the `jobs` table), run by
`jobs/runner.ts` inside core. A job is queued in the transaction that makes it needed
(`kind.enqueue(tx, …)`, `wakeThread(…, { tx })`), so the change and its job commit together.
`jobs/kinds.ts` names every kind something queues; what each does is in its own file, listed in
`jobs/index.ts`, which only the runner imports. The rules:

- **Lanes**: two jobs whose lanes overlap never run at once: one turn a thread (`thread:<id>`), a
  move's venue and holding lanes, one advance a proposal.
- **Keys**: a job is queued once per key (a message id, a wake's id), for two weeks. A debounced
  key (`reading`, `triage:<thread>`) is pushed out by each ask, and one asked for while it runs
  runs again after. That is how a thread's fires close together are judged in one triage.
- **One runner a database**: it holds a Postgres lock for its life, on a session nothing retires
  (`db/session.ts`), and takes each job through that session; one that loses it ends its turns and
  starts nothing until it holds the lock again. So a job marked started that
  it isn't running was cut off (at boot, by a process that died; while it runs, by the write that
  would have ended it failing, settled on its next pass), and its kind's `cutShort` decides: a
  turn that had ended is left as it is; one cut off midway is kept as far as it got, saying it
  was cut off with a Try again (`keepCutTurn`), and run again only in the background having done
  nothing, all judged from the record it wrote as it went (`conversation/turn-record.ts`); nor is
  an answer's delivery to a channel
  (part of it may have gone); a move whose job started but never claimed the move runs, and one
  that claimed it is marked crashed for reconcile, never sent again; a landing check, a proposal
  advance, a reading and a cron just run again. The wallet's `resend()` then delivers what it
  signed and never broadcast, the same bytes (or a stuck EVM send replaced by fee).
- **Background turns** (a watch's wake, the brief, a move landing, money arriving) carry what woke
  them in the job's data. One that fails (an error, a usage limit, or cut off) before doing
  anything (`didNothing`: no tool of Auni's called, which its record says before the tool runs,
  and no move recorded in its thread since it began) keeps and sends nothing
  and runs again as the same job (`again`): when a brain can think after a limit, else in 5
  minutes, for a day from when it was first queued, then is kept as a failed answer that says so.
  One that did anything is kept as it is and never run again. Fires and the brief's held items are
  marked told only in the transaction that keeps an answer that didn't fail
  (`conversation/turn.ts`).
- **Crons** (`every`) are one row each, so slots missed while the machine slept run once. A frozen
  process (sleep) ends running turns as stopped; overdue jobs simply run on wake.
- **Loops** that live as long as Auni (the channels listening, `channels/hub.ts`' `channelsJob`;
  each watch source's run, `automations/sources.ts`' `sourcesJob`) are crons with `endsOnSleep`
  whose run lasts until the runner aborts it, on a sleep or a stop; the cron starts it again, and a
  source catches up from when its cursor was saved. A saved setting ends one too, and it runs
  again at once with it (`untilSettingsChange`). `jobs/keep-running.ts` restarts a loop inside
  one that ends or throws. The runner's lock means one Auni listens, which Telegram's long poll
  needs. Each holds one of the runner's slots for its life. A watch kept by its service is renewed
  by the 6-hourly `automation-renew` cron (`automations/renew.ts`) a day before its lease ends.
- `jobs/faults.db.test.ts` kills a runner in a process of its own at each of these points.
