import { db } from "../db/client.ts";
import { owner } from "../db/schema.ts";
import { sweepArrivals } from "../money/sweep.ts";
import { heldNoBets } from "./world/polymarket.ts";

// `auni demo --first-run`: the demo as a new owner meets it, with no past, no money and their
// first take ahead, so first run plays through for real against the demo's stand-ins: the take
// (scenes.ts' `take`), its first picks on one card with $50 behind them, money sent in while its
// Add money is open, the gulp, the buy, and the spare key. Nothing is seeded but the clock.

/** Makes the demo's new owner, with nothing to their name. Runs once core's jobs and API are up (start.ts). */
export async function seed(): Promise<void> {
  heldNoBets();
  await db.update(owner).set({
    // This machine's, as the browser that opens the demo here says too.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    welcomedAt: null,
    backupSavedAt: null,
    backupLaterAt: null,
  });
  // The first sweep of a wallet only marks where it starts: what comes in after is news.
  await sweepArrivals(true);
}
