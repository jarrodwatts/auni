import postgres from "postgres";

// The demo's clock, for `auni demo --at <moment>`. A demo lays its owner's past on the clock of
// the day it runs, so the dates and the past week it shows differ from one day and one hour to
// the next. Started at a moment, the demo makes its owner in the five minutes before that moment
// and then stands still at it, so every run of one build shows the same thing: what
// `pnpm demo:shots` needs for two sets of pictures to be compared.
//
// Core reads the time through two doors, and this stands in at both, as the demo's world stands
// in for `fetch`: `Date` in this process, and `now()` and `clock_timestamp()` in its Postgres.
// Both must tell one time, since core writes a moment with one and compares it with the other
// (a session's end, a job's turn). This file imports nothing of core's.

/** How long before its moment the demo starts: longer than its owner takes to make. */
const LEAD_MS = 5 * 60_000;

const RealDate = Date;

/** How far behind the real clock the demo's runs, until it stands still. */
let behindMs = 0;
/** The moment the demo's clock stands at, once it does. */
let stoodAt: number | undefined;
/** The moment the clock is to stop at, and the database that stops with it. */
let stopsAt: { readonly at: number; readonly databaseUrl: string } | undefined;

const now = () => stoodAt ?? RealDate.now() - behindMs;

/** `Date`, telling the demo's time wherever it is asked the time: `Date.now()` and `new Date()`. */
const DemoDate = new Proxy(RealDate, {
  construct: (target, args: unknown[], newTarget) =>
    Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget) as object,
  get: (target, key, receiver) =>
    key === "now" ? now : (Reflect.get(target, key, receiver) as unknown),
});

/**
 * The names Postgres tells the time by that core uses, stood in for by a schema of the demo's,
 * which every connection made from here on (every one of core's) finds before Postgres's own:
 * a bare `now()` is the demo's, and tables are still made in `public`. A column's
 * `default now()` is bound when its table is made, so this runs before core's migrations do.
 */
const databaseClock = (behind: number) => `
  create schema demo_clock;
  create table demo_clock.clock (behind interval not null, stood_at timestamptz);
  insert into demo_clock.clock (behind) values (make_interval(secs => ${behind / 1_000}));
  create function demo_clock.now() returns timestamptz language sql stable as
    'select coalesce(stood_at, pg_catalog.now() - behind) from demo_clock.clock';
  create function demo_clock.clock_timestamp() returns timestamptz language sql volatile as
    'select coalesce(stood_at, pg_catalog.clock_timestamp() - behind) from demo_clock.clock';
  do $$ begin
    execute format(
      'alter database %I set search_path = public, demo_clock, pg_catalog', current_database());
  end $$;`;

/**
 * Starts the demo's clock five minutes before `at`, in this process and in the database at
 * `databaseUrl`, which must be new: nothing of core's is in it yet. Called before anything of
 * core's that reads the time is loaded.
 */
export async function startClock(at: number, databaseUrl: string): Promise<void> {
  behindMs = RealDate.now() - (at - LEAD_MS);
  stopsAt = { at, databaseUrl };
  globalThis.Date = DemoDate;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(databaseClock(behindMs));
  } finally {
    await sql.end();
  }
}

/**
 * Stops the demo's clock at the moment it was started for, if it was started for one: from here
 * on it is always that moment, in this process and in the database. So nothing set for later
 * (a check in ten seconds, a cron's next run) ever comes due. The seed calls this once the
 * owner's past is played.
 */
export async function stopClock(): Promise<void> {
  if (!stopsAt) return;
  const { at, databaseUrl } = stopsAt;
  if (now() > at)
    throw new Error(
      `The demo's owner took more than ${LEAD_MS / 60_000} minutes to make, past the moment --at names.`,
    );
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`update demo_clock.clock set stood_at = to_timestamp(${at / 1_000})`);
  } finally {
    await sql.end();
  }
  stoodAt = at;
}
