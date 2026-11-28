import { setTimeout as sleep } from "node:timers/promises";

import type { FailureKind } from "@auni/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import { actions, fills, threads, type ActionRow } from "../db/schema.ts";
import { APPROVED_SALE_OF } from "./approved.ts";
import { fillIdentity, QUANTITY_DECIMALS, type FillKey } from "./fill-key.ts";
import { settling } from "./holding-trades.ts";
import { noted, step } from "./life.ts";
import { type OnItsWay } from "./portfolio.ts";
import { askForReading } from "./readings.ts";
import {
  allFills,
  buyersOf,
  holdersOf,
  ownedMoveFills,
  saleOwners,
  sharedFill,
  threadBooks,
} from "./books.ts";
import { potLeaving, threadFills } from "./pot.ts";
import type { ExecuteResult, Fill, KeptTx, Landed, Recipe } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";
import { centsToUsd, normalizeUsd, parseUnits, usdToCents } from "./usd.ts";
import { evmAddress } from "./wallets.ts";

// Writing down what an action moved. Every write here is safe to repeat.

/**
 * What the recipe reports moving, its transactions, its run's notes and its
 * fills, written together once, with the step to landing when its money
 * arrives later, so a move never has its send recorded without that. A retry
 * after a write that landed unacknowledged, or a second read back of the same
 * trade, finds the fills already there and adds nothing. `heldBefore` is how much of what a sale sells was there just
 * before it ran (see `soldHolding`).
 */
export async function recordResult(
  action: ActionRow,
  result: ExecuteResult,
  heldBefore: HeldBefore | null = null,
  also?: (tx: Tx) => Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const mine = eq(actions.id, action.id);
    // One writer at a time: a trade read back later may be read by reconcile and by the owner's
    // Check again at once, and the second then finds the first's fills and adds nothing.
    await tx.select({ id: actions.id }).from(actions).where(mine).for("update");
    await keepTxs(tx, action.id, result.txs);
    await also?.(tx);
    if (result.run)
      await tx
        .update(actions)
        .set({ run: noted(result.run), updatedAt: sql`now()` })
        .where(mine);
    if (result.run?.lands) await step(tx, "depart", mine);
    const [recorded] = await tx
      .select({ id: fills.id })
      .from(fills)
      .where(eq(fills.actionId, action.id))
      .limit(1);
    if (recorded || result.fills.length === 0) return;
    const filled = filledUsd(action, result.fills);
    if (filled)
      await tx
        .update(actions)
        .set({ run: noted(filled) })
        .where(mine);
    const owned = await attributed(tx, action, result.fills, heldBefore);
    // When a sale outside an auto thread closes part of its holding, lower that thread's budget
    // so cashing out manually never refills its automatic spending allowance.
    const leaving = owned.filter(
      (fill) => fill.side === "sell" && fill.threadId !== null && fill.threadId !== action.threadId,
    );
    if (leaving.length > 0) {
      const byThread = Map.groupBy(leaving, (fill) => fill.threadId!);
      for (const otherId of [...byThread.keys()].sort()) {
        const [other] = await tx
          .select()
          .from(threads)
          .where(eq(threads.id, otherId))
          .for("update");
        if (!other || usdToCents(other.budgetUsd) <= 0n) continue;
        const history = [...(await threadFills(tx, otherId))];
        let budgetUsd = other.budgetUsd;
        for (const sale of byThread.get(otherId) ?? []) {
          budgetUsd = potLeaving(budgetUsd, history, sale);
          history.push(sale);
        }
        if (budgetUsd !== other.budgetUsd) {
          await tx.update(threads).set({ budgetUsd }).where(eq(threads.id, otherId));
        }
      }
    }
    await insertFills(tx, action.id, owned);
  });
}

/**
 * Writes an action's fills, each with the thread it belongs to, or none;
 * one read from a venue's statement with its line and when the venue made it.
 */
export async function insertFills(
  tx: Tx,
  actionId: string,
  owned: readonly (Fill & {
    readonly threadId: string | null;
    readonly ref?: string;
    readonly at?: Date;
    readonly pnlUsd?: string;
  })[],
): Promise<void> {
  await tx.insert(fills).values(
    owned.map((fill) => ({
      actionId,
      threadId: fill.threadId,
      instrument: fill.instrument,
      chain: fill.chain,
      side: fill.side,
      quantity: fill.quantity,
      usdValue: normalizeUsd(fill.usdValue),
      ...(fill.pnlUsd === undefined ? {} : { pnlUsd: fill.pnlUsd }),
      ...(fill.ref ? { venueRef: fill.ref } : {}),
      ...(fill.at ? { createdAt: fill.at } : {}),
    })),
  );
}

/**
 * What a move really moved, from its fills, to the nearest cent: what a sale
 * into cash brought back (a sell, or a sale that only readies cash:
 * convert_to_cash, a token sold home through a bridge), or what a buy spent,
 * which its card showed at the most it could cost. Null for anything else,
 * like a perp, whose fills are its size rather than the margin it moves. Its
 * card rounded its figure the same way, so a move filling exactly at its
 * quote reads the same before and after.
 */
function filledUsd(
  action: ActionRow,
  moved: readonly Fill[],
): { readonly returnedUsd: string } | { readonly spentUsd: string } | null {
  const recipe = recipeForTool(action.tool);
  const input = action.input as never;
  const cents = (side: Fill["side"]) => {
    const micros = moved
      .filter((fill) => fill.side === side)
      .reduce((total, fill) => total + parseUnits(fill.usdValue, 6), 0n);
    return centsToUsd((micros + 5_000n) / 10_000n);
  };
  if (action.details.returnsUsd)
    return recipe?.direction?.(input) === "sell" || recipe?.readies?.(input)
      ? { returnedUsd: cents("sell") }
      : null;
  if (
    moved.some((fill) => fill.side === "buy") &&
    recipe?.direction?.(input) === "buy" &&
    !recipe.readies?.(input)
  )
    return { spentUsd: cents("buy") };
  return null;
}

/** How much of what a sale sells the wallet held, read just before it ran, and when. */
export interface HeldBefore {
  readonly units: bigint;
  readonly readAt: number;
}

/**
 * The holding a recorded action sells, whose wallet amount is read just
 * before it runs, so its sale is written to whichever thread held it. None for
 * a move of the owner's own cash between places, except convert_to_cash which
 * sells a wallet holding into USDC.
 */
export function soldHolding(action: Pick<ActionRow, "tool" | "input" | "details">): FillKey | null {
  const sold = action.details[APPROVED_SALE_OF];
  if (
    !sold ||
    (action.tool !== "convert_to_cash" &&
      recipeForTool(action.tool)?.readies?.(action.input as never))
  )
    return null;
  // The chain may itself hold a colon (eip155:1), so the instrument is what follows the last.
  const at = sold.lastIndexOf(":");
  return { chain: sold.slice(0, at) as FillKey["chain"], instrument: sold.slice(at + 1) };
}

/**
 * Each fill with the thread it belongs to. A move that only gathers the
 * owner's cash for picks owns no more than its thread held. A sale is written
 * to whichever thread held what it sold when what was there just before it
 * could be read and nothing else of it has run since, and what it brought in
 * is theirs in the same shares: one thread may sell another's holding, and the
 * books follow it. What it bought with the owner's own loose holding is its
 * own thread's, as what it buys with their cash is.
 */
async function attributed(
  tx: Tx,
  action: ActionRow,
  moved: readonly Fill[],
  heldBefore: HeldBefore | null,
): Promise<(Fill & { readonly threadId: string | null })[]> {
  const place = action.tool === "convert_to_cash" ? null : action.threadId;
  if (
    place &&
    action.tool !== "convert_to_cash" &&
    recipeForTool(action.tool)?.readies?.(action.input as never)
  )
    return ownedMoveFills(moved, place, await threadFills(tx, place));
  const sold = soldHolding(action);
  if (!sold || heldBefore === null) return moved.map((fill) => ({ ...fill, threadId: place }));
  const key = fillIdentity(sold);
  const sale = (fill: Fill) => fill.side === "sell" && fillIdentity(fill) === key;
  const size = moved
    .filter(sale)
    .reduce((sum, fill) => sum + parseUnits(fill.quantity, QUANTITY_DECIMALS), 0n);
  // Another move of it since the read, or too soon before it to show, leaves the read
  // untrustworthy: written where it was made, as before.
  const meanwhile = await settling(tx, sold, heldBefore.readAt, action.id);
  if (size === 0n || meanwhile.length > 0)
    return moved.map((fill) => ({ ...fill, threadId: place }));
  const books = threadBooks(await allFills(tx));
  const held = holdersOf(heldBefore.units, books, key, place);
  const owners = saleOwners(size, place, held);
  const buyers = buyersOf(owners, place);
  // What it brought in is theirs in the same shares (see buyersOf); a fee or other leg stays
  // where it was made.
  return moved.flatMap((fill) =>
    sale(fill)
      ? sharedFill(fill, owners)
      : fill.side === "buy"
        ? sharedFill(fill, buyers)
        : [{ ...fill, threadId: place }],
  );
}

/**
 * A running move whose result is recorded is done (the `finish` step of its
 * life); `note` is what didn't go as asked, `delivered` the transaction that
 * delivered it, and `bought` what it bought once it landed (see Landed). The
 * one place a move becomes done, so a reading of what it changed is asked for here.
 */
export async function finish(
  actionId: string,
  note?: string,
  delivered?: string,
  bought: readonly Fill[] = [],
): Promise<ActionRow> {
  const done = await db.transaction(async (tx) => {
    const [flipped] = await step(tx, "finish", eq(actions.id, actionId), {
      error: note ?? null,
      // With what delivered it, so an arrival read after can't be taken for someone else's money.
      ...(delivered ? { run: noted({ delivered }) } : {}),
    });
    // Written with the flip, so a running buy's dollars are never counted as free between the
    // two, and only by the write that flipped it, so a retry adds nothing.
    if (flipped && bought.length > 0)
      await insertFills(tx, actionId, await landedOwners(tx, flipped, bought));
    return flipped;
  });
  // A retry after an update that landed unacknowledged still asks for the reading.
  const row = done ?? (await requireAction(actionId));
  if (row.status === "done") {
    // Never fails the move: lost, the next reading still comes when they open Auni, or within a day.
    await askForReading(db).catch((error: unknown) =>
      console.error(`reading after action ${row.id} not asked`, error),
    );
  }
  return row;
}

/**
 * What a move bought once it landed belongs to whoever its own sale was written to, in the
 * same shares (see attributed); with no sale, to its thread.
 */
async function landedOwners(
  tx: Tx,
  action: ActionRow,
  bought: readonly Fill[],
): Promise<(Fill & { readonly threadId: string | null })[]> {
  const sold = await tx
    .select({ threadId: fills.threadId, quantity: fills.quantity })
    .from(fills)
    .where(and(eq(fills.actionId, action.id), eq(fills.side, "sell")));
  const weights = sold.map(
    (fill) => [fill.threadId, parseUnits(fill.quantity, QUANTITY_DECIMALS)] as const,
  );
  return weights.length > 0
    ? bought.flatMap((fill) => sharedFill(fill, buyersOf(weights, action.threadId)))
    : bought.map((fill) => ({ ...fill, threadId: action.threadId }));
}

/**
 * How long a move on its way is watched for: a bridge refunds a deposit no one fills only hours
 * later, and a move still unconfirmed a day after it started is held for the owner (reconcile.ts).
 */
export const LANDING_WINDOW_MS = 12 * 60 * 60_000;

/**
 * Finishes a move on its way once its recipe sees it landed. Once the
 * landing window since it started has passed, it finishes anyway, saying it
 * hasn't shown up yet, so nothing waits on it forever; its transactions still
 * say where it went. A destination that can't be read now is read again next
 * time. Money that never shows up is stuck or a recipe that can't see it
 * arrive, so either way someone is told.
 */
export async function settleLanding(actionId: string): Promise<ActionRow> {
  const action = await requireAction(actionId);
  const recipe = recipeForTool(action.tool);
  if (action.phase !== "landing" || !recipe?.landed) return action;
  const arrived = await landingOf(action, recipe);
  if (arrived) return finish(actionId, arrived.note, arrived.delivered, arrived.bought);
  if (Date.now() - (action.startedAt?.getTime() ?? 0) < LANDING_WINDOW_MS) return action;
  console.error(`Action ${actionId} (${action.tool}) never showed up as landed`);
  return finish(
    actionId,
    `It hasn't shown up as ${action.run.lands} yet. It's usually minutes, but can take longer; check that balance before moving it again.`,
  );
}

/**
 * The owner's moves still on their way: each sent and not yet landed, as its
 * recipe says now, while Portfolio reads their balances alongside. Money
 * usually lands seconds after it is sent, before action-execute next looks
 * and finishes the move, and a balance read then already holds it, so going
 * by the move's status alone would count that money twice. Only the watch
 * finishes it, as it also wakes the thread and moves the proposal on.
 */
export async function onTheirWay(): Promise<OnItsWay[]> {
  const running = await db
    .select()
    .from(actions)
    .where(eq(actions.phase, "landing"))
    .orderBy(asc(actions.seq));
  const landed = await Promise.all(
    running.map((action) => {
      const recipe = recipeForTool(action.tool);
      return recipe?.landed ? landingOf(action, recipe) : null;
    }),
  );
  return running.flatMap(({ id, run, amountUsd }, index) =>
    landed[index] ? [] : [{ actionId: id, lands: run.lands ?? "", usdValue: amountUsd }],
  );
}

/** Whether a move on its way has landed, read now: null while it hasn't, or can't be read. */
async function landingOf(action: ActionRow, recipe: Recipe): Promise<Landed | null> {
  try {
    if (!recipe.landed) return null;
    const owner = await evmAddress();
    if (!owner) return null;
    return await recipe.landed({ action, input: action.input as never, evmAddress: owner });
  } catch (error) {
    console.warn(`action ${action.id}: couldn't read whether it landed`, error);
    return null;
  }
}

/** Whether an action kept a send that was the move itself, not only its setup: something went out. */
export const sentSomething = sql`exists (
  select 1 from jsonb_array_elements(${actions.txs}) kept
  where not coalesce((kept->>'setup')::boolean, false)
)`;

/**
 * A run that ended with nothing moved, and why (see failure.ts). One that
 * kept a send of the move itself is `sent` whatever the reason, so it is
 * never run again as it is; unless its recipe knew nothing moved (an order
 * nobody filled, closed), which stays `unfilled`.
 */
export async function markFailed(
  actionId: string,
  message: string,
  kind: FailureKind,
): Promise<ActionRow> {
  const [failed] = await step(db, "fail", eq(actions.id, actionId), {
    error: message,
    failureKind:
      kind === "unfilled" ? kind : sql`case when ${sentSomething} then 'sent' else ${kind} end`,
  });
  return failed ?? requireAction(actionId);
}

/**
 * A run that stopped short while sending: failed when it sent nothing. Once a
 * transaction went out, money may have moved, so the move is unsure, with the
 * error, and its receipts settle it. A send the wallet accepted counts as out,
 * with a hash or without one. A send that got no answer (see MayHaveSent) is
 * kept in the same write, so the one write that stops the row can't lose it.
 * A move no longer sending (landing, or already stopped) is left as it is.
 */
export async function markStopped(
  actionId: string,
  message: string,
  kind: FailureKind,
  unanswered?: KeptTx,
): Promise<ActionRow> {
  const sending = and(eq(actions.id, actionId), eq(actions.phase, "sending"));
  // The kind is kept while it is unsure too, so a run its receipts fail later still says why it stopped.
  const why = { error: message, failureKind: kind };
  // A post kept as maybe sent before it went (see Recipe posting) is already this mark.
  const mark = JSON.stringify(unanswered);
  const [unsure] = unanswered
    ? await step(db, "stop", sending, {
        ...why,
        txs: sql`case when exists (
          select 1 from jsonb_array_elements(${actions.txs}) kept where kept = ${mark}::jsonb
        ) then ${actions.txs} else ${actions.txs} || jsonb_build_array(${mark}::jsonb) end`,
      })
    : await step(db, "stop", and(sending, sql`jsonb_array_length(${actions.txs}) > 0`), why);
  const [stopped] = unsure ? [unsure] : await step(db, "fail", sending, why);
  return stopped ?? requireAction(actionId);
}

/**
 * A run that died partway: its job cut short after it claimed the move (see
 * the action kind's cutShort in jobs/action.ts). Unsure when it kept a send:
 * a wallet's is journalled before it is broadcast, and a venue's post is kept
 * before it goes (see Recipe posting), so one cut off while the venue hadn't
 * answered is read on and held, never failed. One that kept nothing still
 * counts as sent, and never runs again on a tap.
 */
export function markCrashed(actionId: string): Promise<ActionRow> {
  return markStopped(
    actionId,
    "The action stopped before finishing. Check its transactions before trying again.",
    "sent",
  );
}

/**
 * Adds the transactions the row doesn't have yet: each is kept once, however
 * often it is reported, by its hash or, before it has one, by the wallet's or
 * the relayer's id for it.
 */
export async function keepTxs(
  executor: Pick<typeof db, "update">,
  actionId: string,
  txs: readonly KeptTx[],
): Promise<void> {
  if (txs.length === 0) return;
  await executor
    .update(actions)
    .set({
      txs: sql`${actions.txs} || coalesce((
        select jsonb_agg(sent) from jsonb_array_elements(${JSON.stringify(txs)}::jsonb) sent
        where not exists (
          select 1 from jsonb_array_elements(${actions.txs}) kept
          where kept->>'hash' = sent->>'hash'
            or (sent->>'hash' is null and kept->>'walletTxId' = sent->>'walletTxId')
            or (sent->>'hash' is null and kept->>'relayerId' = sent->>'relayerId')
        )
      ), '[]'::jsonb)`,
      updatedAt: sql`now()`,
    })
    .where(eq(actions.id, actionId));
}

/**
 * Takes off the last send kept exactly as `mark`, one with nothing to read: a post the venue
 * turned away, which was kept as maybe sent only while it hadn't answered (see Recipe posting).
 */
export async function dropMark(actionId: string, mark: KeptTx): Promise<void> {
  const json = JSON.stringify(mark);
  await db
    .update(actions)
    .set({
      txs: sql`(
        select coalesce(jsonb_agg(kept order by at), '[]'::jsonb)
        from jsonb_array_elements(${actions.txs}) with ordinality as sent(kept, at)
        where at <> coalesce((
          select max(at) from jsonb_array_elements(${actions.txs}) with ordinality as same(kept, at)
          where kept = ${json}::jsonb
        ), 0)
      )`,
      updatedAt: sql`now()`,
    })
    .where(eq(actions.id, actionId));
}

/** A sent transaction never fails the recipe that sent it just because writing it down did. */
export async function keepTxsSafely(actionId: string, txs: readonly KeptTx[]): Promise<void> {
  try {
    await retried(() => keepTxs(db, actionId, txs));
  } catch (error) {
    console.error(`action ${actionId}: couldn't record sent transactions`, txs, error);
  }
}

/** A write that failed is tried again a few times before the caller gives up on it. */
export async function retried<T>(write: () => Promise<T>): Promise<T> {
  for (const wait of [250, 1_000, 4_000]) {
    try {
      return await write();
    } catch (error) {
      console.warn("write failed, retrying", error);
      await sleep(wait);
    }
  }
  return write();
}

export async function requireAction(actionId: string): Promise<ActionRow> {
  const [row] = await db.select().from(actions).where(eq(actions.id, actionId));
  if (!row) throw new Error(`Action ${actionId} not found.`);
  return row;
}
