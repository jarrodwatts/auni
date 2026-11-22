import { keptSecret } from "./data-dir.ts";
import { openPostgres, PostgresMismatch, type Postgres } from "./db/embedded.ts";
import { readSettings } from "./settings.ts";

// env.ts reads the environment once, when first imported, and nearly everything imports it (the
// database client among them). So `auni` readies the environment here first and imports the
// rest after: only data-dir.ts, db/embedded.ts and settings.ts come before, and none reads env.ts.

/** The Postgres boot() opened for this process: Auni's own, or null with the owner's. */
let opened: Postgres | null = null;

/**
 * Readies the process and what env.ts reads: the owner's .env in the data folder (what's already
 * set wins), a turn-token secret kept there when none is set, and DATABASE_URL: when unset,
 * Auni's own Postgres, started if it's stopped. Returns that Postgres, to release when done.
 * `runsAuni` is `auni` itself, whose Postgres is its own (db/embedded.ts); `waiting` says why it
 * waits, should another auni command hold that Postgres.
 */
export async function boot({
  runsAuni = false,
  waiting = (line) => console.log(line),
}: {
  readonly runsAuni?: boolean;
  readonly waiting?: (line: string) => void;
} = {}): Promise<Postgres | null> {
  // Node's diagnostic report looks up every open socket's peer by name, synchronously, which
  // freezes the whole program for seconds once Auni holds connections to RPCs and price feeds.
  // The Claude Agent SDK takes a report on every query() (to tell glibc from musl), so without
  // this each turn and each triage froze Auni: Telegram, the jobs and the turns running alike.
  // (Node 22 and later; @types/node doesn't know it yet.)
  Object.assign(process.report, { excludeNetwork: true });
  readSettings();
  if (!process.env.TURN_TOKEN_SECRET?.trim())
    process.env.TURN_TOKEN_SECRET = keptSecret("turn-token-secret");
  if (process.env.DATABASE_URL?.trim()) return null;
  const database = await openPostgres({
    runsAuni,
    onWait: () =>
      waiting(
        "Auni's database is in use by another auni command, or by the Auni stopped a moment ago, still finishing what it was running. This one starts as soon as it's let go of.",
      ),
  }).catch((error: unknown) => {
    // Said plainly, without a stack: the message is the way out (db/embedded.ts).
    if (!(error instanceof PostgresMismatch)) throw error;
    console.error(error.message);
    process.exit(1);
  });
  process.env.DATABASE_URL = database.url;
  opened = database;
  return database;
}

/**
 * Lets go of Auni's own Postgres before a command starts the Auni that runs here (its service, or
 * in the background), so that Auni starts Postgres as its own rather than wait for this command.
 * The command asks the database nothing more until that Auni is up (running.ts, `cameUp`), then
 * holds it again (`holdAgain`) if it needs it.
 */
export async function letGo(): Promise<void> {
  await opened?.release();
}

/** Holds Auni's own Postgres again: after `letGo`, or after the Auni that kept it stopped it. */
export async function holdAgain(): Promise<void> {
  await opened?.hold();
}

/** Runs a command that needs the database (pairing, importing keys), then lets go of it. */
export async function withDatabase<T>(command: () => Promise<T>): Promise<T> {
  const database = await boot();
  try {
    return await command();
  } finally {
    const { closeDatabaseConnection } = await import("./db/client.ts");
    await closeDatabaseConnection();
    await database?.release();
  }
}
