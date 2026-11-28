/**
 * A terminal sends Ctrl-C to the whole process group, and pnpm can relay it too.
 * Only an interrupt at least a second after the first counts as another press.
 */
function ctrlCHandler(stop: () => void, force: () => void = () => process.exit(130)): () => void {
  let firstInterrupt: number | undefined;
  return () => {
    const now = performance.now();
    if (firstInterrupt === undefined) {
      firstInterrupt = now;
      stop();
    } else if (now - firstInterrupt >= 1_000) force();
  };
}

/**
 * Calls `stop` with the exit code to leave with each time Auni is asked to stop. SIGTERM (`auni
 * stop`, a service's stop) stops gently with 0 however often it comes, so asking again never cuts
 * a send short; Ctrl-C (SIGINT) stops gently with 130, and a second press stops at once. Closing
 * the terminal window hangs up on Auni (SIGHUP), which Node would otherwise die of at once,
 * leaving its Postgres running in a session of its own: Auni stops gently instead, with nowhere
 * left to print, so a write to the closed terminal can't kill it on the way.
 *
 * Returns a function that removes the listeners.
 */
export function onStopAsked(
  stop: (code: number) => void,
  signals: NodeJS.EventEmitter = process,
  force: () => void = () => process.exit(130),
): () => void {
  const onTerm = () => stop(0);
  const onHup = () => {
    for (const out of [process.stdout, process.stderr]) out.on("error", () => {});
    stop(0);
  };
  const onInt = ctrlCHandler(() => stop(130), force);
  signals.on("SIGTERM", onTerm);
  signals.on("SIGHUP", onHup);
  signals.on("SIGINT", onInt);
  return () => {
    signals.off("SIGTERM", onTerm);
    signals.off("SIGHUP", onHup);
    signals.off("SIGINT", onInt);
  };
}

interface BootControl {
  /** Aborted the moment Ctrl-C, SIGTERM or SIGHUP asks Auni to stop during boot. */
  readonly signal: AbortSignal;
  /** Give `database` to this guard so it is released if boot is stopped before `start()`. */
  hold(database: { release(): Promise<void> } | null): void;
  /** Calls `begin` (`start()`, which installs its own stop handlers), unless a stop came first. */
  handOff(begin: () => Promise<void>): Promise<void>;
}

/**
 * Guards startup before `start()` installs its own stop handlers (both `auni` and `auni demo`):
 * cancels in-flight boot steps, releases Postgres if it came up, exits quietly with the signal's
 * exit code, and removes its listeners as soon as `start()` takes over.
 */
export async function whileBooting(
  run: (boot: BootControl) => Promise<void>,
  {
    onStop,
    signals = process,
  }: { readonly onStop?: () => void; readonly signals?: NodeJS.EventEmitter } = {},
): Promise<void> {
  const abort = new AbortController();
  let database = null as { release(): Promise<void> } | null;
  let exitCode: number | undefined;
  let handedOff = false;
  const off = onStopAsked(
    (code) => {
      if (abort.signal.aborted) return;
      exitCode = code;
      abort.abort();
      onStop?.();
    },
    signals,
    () => {
      // Once Postgres is up, a second Ctrl-C stops at once; before that, exiting can orphan initdb/pg_ctl.
      if (database) process.exit(130);
    },
  );
  try {
    await run({
      signal: abort.signal,
      hold(db) {
        database = db;
      },
      async handOff(begin) {
        // A signal that came while start.ts loaded (a second or more, all at once) is heard first.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (abort.signal.aborted) return;
        handedOff = true;
        database = null;
        // start() adds its listeners before these go: with none left for a moment, Node would
        // drop a signal still on its way.
        const started = begin();
        off();
        return started;
      },
    });
  } catch (error) {
    if (!abort.signal.aborted) await new Promise<void>((resolve) => setImmediate(resolve));
    if (!abort.signal.aborted) throw error;
  } finally {
    try {
      if (!handedOff && database) await database.release();
    } finally {
      off();
      if (!handedOff && exitCode !== undefined) process.exitCode = exitCode;
    }
  }
}
