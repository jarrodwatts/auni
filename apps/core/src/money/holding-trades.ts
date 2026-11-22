import { RAW_TRANSACTION_TOOLS } from "@auni/shared";
import { and, ne } from "drizzle-orm";

import type { Tx } from "../db/client.ts";
import { actions, type ActionRow } from "../db/schema.ts";
import { APPROVED_SALE_OF } from "./approved.ts";
import { fillIdentity, tokenKey, type FillKey } from "./fill-key.ts";
import { stillSettling } from "./readings.ts";
import { shownHoldings } from "./raw-transaction.ts";
import { subjectOf } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";

// Which of the owner's recorded moves may change how much of one holding the
// wallet has, for anything that reads that amount and must know it holds.

/**
 * Whether a raw transaction moves this holding, on its own chain, by what its
 * simulation showed it sending, or getting too unless `sendsOnly`; null when
 * it was drawn without one, so it could move anything there.
 */
function rawMoves(
  row: Pick<ActionRow, "tool" | "input" | "details">,
  holding: FillKey,
  sendsOnly: boolean,
): boolean | null {
  const { chain, moved } = shownHoldings(row);
  if (chain !== holding.chain) return false;
  if (!moved) return null;
  return [...moved.sends, ...(sendsOnly ? [] : moved.gets)].some(
    (key) => fillIdentity(key) === fillIdentity(holding),
  );
}

/**
 * Whether a recorded move trades this holding: true when it sells it, a raw
 * transaction by what it moves, else true or false when what it's about says,
 * and null when code can't tell. A swap is about what it buys.
 */
function tradesHolding(
  row: Pick<ActionRow, "tool" | "input" | "details" | "amountUsd">,
  holding: FillKey,
): boolean | null {
  if (row.details[APPROVED_SALE_OF] === fillIdentity(holding)) return true;
  if (RAW_TRANSACTION_TOOLS.includes(row.tool)) return rawMoves(row, holding, false);
  const recipe = recipeForTool(row.tool);
  const subject = recipe ? subjectOf(recipe, row) : null;
  if (!subject || subject.kind === "app") return null;
  return (
    subject.kind === "token" &&
    fillIdentity(tokenKey(subject.chain, subject.mint)) === fillIdentity(holding)
  );
}

/**
 * The owner's moves, but `except`, that may change this holding and that a read
 * begun at `readStartedAt` may not show (see stillSettling).
 */
export async function settling(
  q: Pick<Tx, "select">,
  holding: FillKey,
  readStartedAt: number,
  except?: string,
): Promise<ActionRow[]> {
  const rows = await q
    .select()
    .from(actions)
    .where(and(except ? ne(actions.id, except) : undefined, stillSettling(readStartedAt)));
  return rows.filter((row) => tradesHolding(row, holding) !== false);
}
