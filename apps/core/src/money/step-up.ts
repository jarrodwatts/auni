import { and, eq, sql } from "drizzle-orm";

import type { ProofRefusal } from "../auth/proof.ts";
import { db } from "../db/client.ts";
import { actions, type ActionRow } from "../db/schema.ts";
import { stepUpReason, stepUpWhy } from "./effect.ts";
import { pastDestinations } from "./withdrawals.ts";

// Money leaving for somewhere the owner has never sent to, and anything else a tap can't vouch
// for (see stepUpReason in effect.ts), needs proof on top of the tap that the owner is there
// (auth/proof.ts). The proof is judged in the request that allows the action, so there is no time
// between the two for the card to change in, and it is recorded on the action itself
// (`stepUpAt`), which execution checks again. What it guards is Auni: the agent, a channel, or
// someone at a browser paired long ago, such as an unlocked laptop, can't have Auni send money
// somewhere new.

/** Where the owner has sent money before, read only for a move whose money leaves them. */
const knownTo = (action: Pick<ActionRow, "details">) =>
  action.details.leavesTo === undefined ? [] : pastDestinations();

/** Whether allowing this action takes proof the owner is there, as the ladder weighs its card now. */
export async function needsStepUp(action: Pick<ActionRow, "details">): Promise<boolean> {
  return stepUpReason(action.details, await knownTo(action)) !== null;
}

/** Why allowing this action takes proof the owner is there, in a sentence for its card; null when a tap will do. */
export async function stepUpSays(action: Pick<ActionRow, "details">): Promise<string | null> {
  return stepUpWhy(action.details, await knownTo(action));
}

/**
 * Whether the owner may allow this waiting action now. Null lets the tap through: an action that
 * takes no proof, one already confirmed (a second tap after an answer got lost), or a tap that
 * proves the owner is there (`ownerHere`), which records the proof execution checks.
 */
export async function stepUpRefusal(
  action: ActionRow,
  ownerHere: boolean,
): Promise<ProofRefusal | null> {
  if (action.stepUpAt || !(await needsStepUp(action))) return null;
  if (!ownerHere) return "pair_again";
  // Only while it still waits: one that moved on meanwhile (declined, replaced) stays
  // unconfirmed, and Allow answers that it isn't waiting.
  await db
    .update(actions)
    .set({ stepUpAt: sql`now()` })
    .where(and(eq(actions.id, action.id), eq(actions.status, "awaiting_permission")));
  return null;
}

/** Execution's own check: an action that takes the owner's proof runs only once it recorded it. */
export async function assertStepUp(action: ActionRow): Promise<void> {
  if (action.stepUpAt || !(await needsStepUp(action))) return;
  throw new Error("Auni never checked it was you allowing this one, so nothing was sent.");
}
