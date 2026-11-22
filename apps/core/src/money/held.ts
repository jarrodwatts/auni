import { CLOSED } from "@auni/shared";
import { and, eq, sql } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import { actions, threads, type ActionRow } from "../db/schema.ts";
import { toldSettled } from "../jobs/action.ts";
import { APPROVED_SALE } from "./approved.ts";
import { walkPositions } from "./books.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import { noted, step } from "./life.ts";
import { potLeaving, threadFills } from "./pot.ts";
import { askForReading } from "./readings.ts";
import { recipeForTool } from "./recipes/index.ts";
import { settleFromReceipts } from "./reconcile.ts";
import { insertFills, requireAction, soldHolding } from "./record.ts";
import { centsToUsd, formatUnits, parseUnits, usdToCents } from "./usd.ts";

// The owner's two taps on a held move (see `needs_owner` in life.ts): Check again and Close.
// Neither sends anything, and neither records what a move got or brought in that Auni didn't
// read from the chain or the venue: Check again is the read reconcile makes, made now, and
// Close ends the move, saying it was closed, with its thread's budget on the safe side.

/**
 * Reads a held move again now, as reconcile does every ten minutes: settled if its receipts or
 * its venue now say what it did, and its thread told as for any move that settles; left held if
 * they still don't. Null for a move that isn't held, which a tap from a screen behind may name.
 */
export async function checkHeld(actionId: string): Promise<ActionRow | null> {
  const held = await requireAction(actionId);
  if (held.phase !== "needs_owner") return null;
  const settled = await settleFromReceipts(held).catch((error: unknown) => {
    console.warn(`held action ${actionId} couldn't be read again`, error);
    return null;
  });
  if (settled) await toldSettled(settled);
  return settled ?? requireAction(actionId);
}

/**
 * Closes a held move at the owner's word, after one more read (a record beats a close): done
 * when its money had moved, failed as sent when nothing shows it went, never to run again
 * either way, with words that say the owner closed it (see CLOSED). Its thread's books
 * then count it as gone either way (see leaveThread), and its thread is told. Null for a
 * move that isn't held.
 */
export async function closeHeld(actionId: string): Promise<ActionRow | null> {
  const read = await checkHeld(actionId);
  if (read?.phase !== "needs_owner") return read;
  const moved = read.run.held === "unrecorded";
  const mine = and(eq(actions.id, actionId), eq(actions.phase, "needs_owner"));
  const closedBy = { run: noted({ settledBy: "owner" }) };
  const closed = await db.transaction(async (tx) => {
    const [row] = moved
      ? await step(tx, "finish", mine, { ...closedBy, error: CLOSED.moved })
      : await step(tx, "fail", mine, { ...closedBy, error: CLOSED.unknown, failureKind: "sent" });
    // Only the Close that closed it, so three at once change the books once.
    if (row) await leaveThread(tx, row);
    return row;
  });
  if (!closed) return requireAction(actionId);
  if (moved)
    await askForReading(db).catch((error: unknown) =>
      console.error(`reading after closing action ${actionId} not asked`, error),
    );
  await toldSettled(closed);
  return closed;
}

/**
 * Takes a closed move out of its thread's books as though it went, whether or not it did:
 * Auni will learn no more of it, and a thread acting on its own must never spend money that
 * may be spent or sell what may be sold. A buy keeps its dollars spent, lowering the budget by
 * them. A sale's holding leaves the thread, up to what its card approved selling (see potLeaving),
 * so what it brought in isn't the thread's to spend either. A sale's holding is written outside
 * the thread at the same cost, so the wallet's figures don't move.
 */
async function leaveThread(tx: Tx, row: ActionRow): Promise<void> {
  if (!row.threadId) return;
  const mine = eq(threads.id, row.threadId);
  const [thread] = await tx.select().from(threads).where(mine).for("update");
  if (!thread || usdToCents(thread.budgetUsd) <= 0n) return;
  const direction = recipeForTool(row.tool)?.direction?.(row.input as never);
  if (direction === "buy") {
    await tx
      .update(threads)
      .set({ budgetUsd: sql`greatest(${threads.budgetUsd} - ${row.amountUsd}::numeric, 0)` })
      .where(mine);
    return;
  }
  const sold = direction === "sell" ? soldHolding(row) : null;
  const approved = row.details[APPROVED_SALE];
  if (!sold || !approved) return;
  const recorded = await threadFills(tx, thread.id);
  const position = walkPositions(recorded).positions.get(fillIdentity(sold));
  if (!position || position.quantity <= 0n) return;
  const asked = parseUnits(approved, QUANTITY_DECIMALS);
  const leaving = asked < position.quantity ? asked : position.quantity;
  // At what it cost, so the books show no gain or loss Auni never saw.
  const leaves = {
    ...sold,
    side: "sell" as const,
    quantity: formatUnits(leaving, QUANTITY_DECIMALS),
    usdValue: centsToUsd((position.cost * leaving) / position.quantity),
  };
  await insertFills(tx, row.id, [
    { ...leaves, threadId: thread.id },
    { ...leaves, side: "buy", threadId: null },
  ]);
  await tx
    .update(threads)
    .set({ budgetUsd: potLeaving(thread.budgetUsd, recorded, leaves) })
    .where(mine);
}
