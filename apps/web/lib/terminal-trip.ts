/**
 * A trip to the terminal this browser sent its owner on: a step took proof they are there, the
 * browser had none to give, and the step said to run `auni pair` (see `PairAgain`). The pairing
 * link opens a new tab, so where they were is kept on the device for it: that tab goes back there.
 */

const TRIP_KEY = "auni:terminal-trip";
/** A pairing link works for 15 minutes; a trip older than that came to nothing. */
const TRIP_MS = 20 * 60_000;

/** Storage can be blocked: the trip is then forgotten, and the owner finds their own way back. */
function stored(act: (storage: Storage) => string | null): string | null {
  try {
    return act(localStorage);
  } catch {
    return null;
  }
}

/** Remembers the page of the app, as its address names it, the owner was sent to the terminal from. */
export function noteTerminalTrip(path: string): void {
  if (!path.startsWith("/app")) return;
  stored((storage) => {
    storage.setItem(TRIP_KEY, `${Date.now()} ${path}`);
    return null;
  });
}

/** Ends the trip, in the tab the pairing link opened: where the owner was, or null with none. */
export function endTerminalTrip(): string | null {
  const trip = stored((storage) => {
    const kept = storage.getItem(TRIP_KEY);
    storage.removeItem(TRIP_KEY);
    return kept;
  });
  const [at, path] = trip?.split(" ") ?? [];
  return path && Date.now() - Number(at) < TRIP_MS ? path : null;
}
