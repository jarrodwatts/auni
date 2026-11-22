import type { ActionQuoteWire } from "@auni/shared";
import { and, eq, or, sql, TransactionRollbackError } from "drizzle-orm";

import { publishThread } from "../conversation/threads.ts";
import { db, type Tx } from "../db/client.ts";
import { actions, specialists, fills, type ActionRow } from "../db/schema.ts";
import {
  approvedDetails,
  cardRuns,
  prepareLeg,
  proposalActions,
  queueExecution,
  startProposal,
} from "./actions.ts";
import { insideApproved, PriceMoved } from "./approved.ts";
import { retryRefusal, type RetryRefusal } from "./failure.ts";
import { unpaid } from "./funding.ts";
import { lockCards } from "./pot.ts";
import { step } from "./life.ts";
import { legsToRetry, stagedLeg } from "./proposal-order.ts";
import { recipeForTool } from "./recipes/index.ts";
import { sentSomething } from "./record.ts";

// Try again on a step that didn't go through. A failed step sent nothing, and
// execute quotes afresh inside the bounds the person approved, so running the
// same row again is safe: it never widens what was approved, and one tap runs
// it once (see runAgain). A price that moved runs again only once a fresh
// quote is back inside those bounds, as its card says (see quoteAgain).

/** What a tap on Try again came to. */
export type Retried =
  | { readonly kind: "running" }
  | { readonly kind: "refused"; readonly reason: RetryRefusal | "short_of_money" }
  /** It isn't the failed run the person saw any more: another tap ran it, or it changed. */
  | { readonly kind: "moved_on" };

const refused = (reason: RetryRefusal | "short_of_money"): Retried => ({ kind: "refused", reason });

/**
 * Runs one failed action again, as `attempts` (the run the person saw fail)
 * plus one. A leg of a proposal runs again only with its card, in its order.
 */
export async function retryAction(row: ActionRow, attempts: number): Promise<Retried> {
  if (row.proposalId) return refused("not_retryable");
  const refusal = retryRefusal(row);
  if (refusal) return refused(refusal);
  if ((await pricedPast([row])).size > 0) return refused("not_retryable");
  return runAgain([{ ...row, attempts }], (tx, again) => queueExecution(tx, again));
}

/**
 * Runs a proposal's failed legs again (see legsToRetry) from the stage they
 * stopped at, as the card's `runs` (see cardRuns) the person saw plus these.
 * Null for a proposal there is no such card of.
 */
export async function retryProposal(proposalId: string, runs: number): Promise<Retried | null> {
  const legs = await proposalActions(proposalId);
  if (legs.length === 0) return null;
  if (cardRuns(legs) !== runs) return { kind: "moved_on" };
  const ids = legsToRetry(legs, await pricedPast(legs));
  if (!ids) return refused("not_retryable");
  return runAgain(
    legs.filter((leg) => ids.includes(leg.id)),
    async (tx) => startProposal(tx, await proposalActions(proposalId, tx)),
  );
}

/**
 * Puts failed rows back to queued (the `retry` step of a move's life), each as one more attempt,
 * and starts them in the same transaction. Their cash is checked first, as a
 * card's is before it is shown. One conditional update, under the lock a card
 * is recorded under, moves all of them or none: each still failed at the
 * attempt the person saw, with nothing of the move itself sent and no fills,
 * and not in a specialist retired since. So a second tap, or one from a screen
 * behind, moves nothing.
 */
async function runAgain(
  rows: readonly ActionRow[],
  start: (tx: Tx, again: ActionRow[]) => Promise<void>,
): Promise<Retried> {
  const short = await unpaid(rows.map(stagedLeg)).catch((error: unknown) => {
    // Execute checks the money again, so a read that failed holds nothing up.
    console.warn(`cash for retrying ${rows.map((row) => row.id).join(", ")} unreadable`, error);
    return null;
  });
  if (short) return refused("short_of_money");
  const again = await db
    .transaction(async (tx) => {
      await lockCards(tx);
      const reset = await step(
        tx,
        "retry",
        and(
          or(...rows.map((row) => and(eq(actions.id, row.id), eq(actions.attempts, row.attempts)))),
          sql`not ${sentSomething}`,
          sql`not exists (select 1 from ${fills} where ${fills.actionId} = ${actions.id})`,
          sql`(${actions.specialistId} is null or exists (
            select 1 from ${specialists}
            where ${specialists.id} = ${actions.specialistId} and ${specialists.status} <> 'retired'
          ))`,
        ),
        {
          attempts: sql`${actions.attempts} + 1`,
          previousErrors: sql`${actions.previousErrors} || jsonb_build_array(jsonb_build_object(
          'error', ${actions.error}, 'kind', ${actions.failureKind}, 'at', ${actions.updatedAt}))`,
        },
      );
      // One that moved on since it was read leaves every row as it was.
      if (reset.length !== rows.length) tx.rollback();
      await start(tx, reset);
      return reset;
    })
    .catch((error: unknown) => {
      if (error instanceof TransactionRollbackError) return null;
      throw error;
    });
  if (!again) return { kind: "moved_on" };
  // The thread's row shows its money moving again.
  const threadIds = new Set(again.flatMap((row) => (row.threadId ? [row.threadId] : [])));
  await Promise.all([...threadIds].map(publishThread));
  return { kind: "running" };
}

/**
 * A failed step priced again now, read only: its recipe describes it afresh,
 * which sends nothing and writes nothing. It is described held to its own
 * card, as execute will run it, so a price execute would refuse (PriceMoved)
 * is outside, and one execute would hold to the card is inside; what's left
 * is weighed against the bounds the card pinned (see insideApproved). A step
 * that's outside is priced again unheld, to show where the market is.
 */
export async function quoteAgain(row: ActionRow): Promise<ActionQuoteWire> {
  const recipe = recipeForTool(row.tool);
  if (!recipe) throw new Error(`No recipe handles ${row.tool}.`);
  const context = { specialistId: row.specialistId };
  const held = await prepareLeg(recipe, row.input, { ...context, heldTo: row }).catch(
    (error: unknown) => {
      if (error instanceof PriceMoved) return null;
      throw error;
    },
  );
  const { preview } = held ?? (await prepareLeg(recipe, row.input, context));
  return {
    amountUsd: preview.amountUsd,
    // One unit's price as the new card would say it; null for a move priced without one.
    price: preview.card?.price ?? null,
    inside: held !== null && insideApproved(row, { details: approvedDetails(preview) }),
  };
}

/**
 * The failed steps among `rows` whose price moved and, quoted again now, is
 * still past what was approved, or can't be read: running them again would
 * only be refused, so they wait for new terms.
 */
async function pricedPast(rows: readonly ActionRow[]): Promise<Set<string>> {
  const moved = rows.filter((row) => row.status === "failed" && row.failureKind === "price");
  const inside = await Promise.all(
    moved.map((row) =>
      quoteAgain(row).then(
        (quote) => quote.inside,
        (error: unknown) => {
          console.warn(`quote for retrying ${row.id} unreadable`, error);
          return false;
        },
      ),
    ),
  );
  return new Set(moved.filter((_, index) => !inside[index]).map((row) => row.id));
}
