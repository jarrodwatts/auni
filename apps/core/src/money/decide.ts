import { CARD_FORMAT, isAsk } from "@auni/shared";
import { and, eq, sql } from "drizzle-orm";

import type { ProofRefusal } from "../auth/proof.ts";
import { db } from "../db/client.ts";
import { actions, type ActionRow } from "../db/schema.ts";
import { actionById, decideActions, proposalActions } from "./actions.ts";
import { stepUpRefusal } from "./step-up.ts";
import { takeBackStale } from "./waiting.ts";

// The owner's Allow and Decline, whichever app their tap came from: the web app's routes
// (money/routes.ts) and every channel (channels/hub.ts) decide a card only through here, so one
// decision wins everywhere and no door skips the proof a card takes that the owner is at the
// computer. decideActions queues an allowed move, and wakes a declined card's thread, in the
// transaction that decides it.

/** What the owner is told of a card drawn before cards said all they say now. */
export const OUT_OF_DATE =
  "This card is out of date, so Auni took it back. Auni will put it up again fresh if it still fits.";

/**
 * Whether any waiting money card here was drawn before cards said all they say now (see
 * CARD_FORMAT): the owner saw less than a card says today, so a tap on it allows nothing. An ask's
 * card says what it changes in Auni, which no format has changed. Such a plan asks for no money
 * either, since it can never run. The tap takes it back, with every card that can no longer be
 * allowed as shown (takeBackStale), so its thread is woken and a reload never shows it waiting.
 */
export function outOfDate(rows: readonly ActionRow[]): boolean {
  return rows.some(
    (row) =>
      row.status === "awaiting_permission" && !isAsk(row.tool) && row.cardFormat < CARD_FORMAT,
  );
}

type Allowed =
  | { readonly kind: "allowed"; readonly action: ActionRow }
  /** Its card was drawn before cards said all they say now (see outOfDate). */
  | { readonly kind: "out_of_date" }
  /** It takes proof the owner is there, which this tap didn't carry. */
  | { readonly kind: "refused"; readonly reason: ProofRefusal }
  /** It isn't waiting any more: decided already, or replaced. */
  | { readonly kind: "not_waiting" }
  /** It asks for a secret, so only saving that in its field allows it (secretSaved). */
  | { readonly kind: "in_its_field" };

/**
 * Allows one waiting action and queues its run. `ownerHere` is whether the tap proved the owner is
 * there (auth/proof.ts), for a card that takes it: only the web app's own route can.
 */
export async function allowAction(actionId: string, ownerHere = false): Promise<Allowed> {
  const waiting = await actionById(actionId);
  if (waiting?.tool === "request_secret") return { kind: "in_its_field" };
  if (waiting && outOfDate([waiting])) {
    await takeBackStale();
    return { kind: "out_of_date" };
  }
  if (waiting?.status === "awaiting_permission") {
    const refusal = await stepUpRefusal(waiting, ownerHere);
    if (refusal) return { kind: "refused", reason: refusal };
  }
  const [allowed] = await decideActions({ actionId }, "allow");
  return allowed ? { kind: "allowed", action: allowed } : { kind: "not_waiting" };
}

/** Declines one waiting action, which tells its thread; null when it wasn't waiting. */
export async function declineAction(actionId: string): Promise<ActionRow | null> {
  const [declined] = await decideActions({ actionId }, "decline");
  return declined ?? null;
}

/**
 * Allows every waiting leg of a proposal and queues its first stage: the legs it allowed, or
 * "out_of_date" for a card drawn before cards said all they say now, which allows none.
 */
export async function allowProposal(proposalId: string): Promise<ActionRow[] | "out_of_date"> {
  if (outOfDate(await proposalActions(proposalId))) {
    await takeBackStale();
    return "out_of_date";
  }
  return decideActions({ proposalId }, "allow");
}

/** Declines every waiting leg of a proposal, which tells its thread: the legs it declined. */
export function declineProposal(proposalId: string): Promise<ActionRow[]> {
  return decideActions({ proposalId }, "decline");
}

/**
 * Allows every card waiting on this private field, now that its secret is saved, by the card's own
 * field or any other place the field is drawn: each wakes its thread saying so (asks.ts), which
 * is all the agent ever hears of it.
 */
export async function secretSaved(field: string): Promise<void> {
  const waiting = await db
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.tool, "request_secret"),
        eq(actions.status, "awaiting_permission"),
        sql`${actions.input}->>'field' = ${field}`,
      ),
    );
  for (const { id } of waiting) await decideActions({ actionId: id }, "allow");
}
