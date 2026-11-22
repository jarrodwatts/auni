import { settingsChanged } from "../settings.ts";

/** How long a loop that ended or threw waits before it starts again. */
const RESTART_MS = 5_000;

/**
 * Runs `run` until `signal` aborts, again 5s after it ends or throws: a long-lived loop inside a
 * job (a channel listening, a source streaming), which the job's cron starts again after a sleep
 * or a stop aborts it.
 */
export async function keepRunning(
  name: string,
  run: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await run(signal);
    } catch (error) {
      if (!signal.aborted) console.error(`${name} stopped`, error);
    }
    await pause(RESTART_MS, signal);
  }
}

/**
 * Runs a job's loop that reads the owner's settings once as it starts (which channels are set up,
 * which sources), until `signal` aborts or a setting is saved. A save ends the loop and has the
 * job run again at once, so what was saved is in use without a restart.
 */
export async function untilSettingsChange(
  signal: AbortSignal,
  loop: (signal: AbortSignal) => Promise<void>,
): Promise<void | { readonly again: number }> {
  const changed = settingsChanged();
  await loop(AbortSignal.any([signal, changed]));
  if (changed.aborted && !signal.aborted) return { again: 0 };
}

/** Waits `ms`, or until `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}
