import { and, asc, eq, sql } from "drizzle-orm";

import type { Tx } from "../db/client.ts";
import { actions, fills, type SpecialistRow } from "../db/schema.ts";
import { APPROVED_SALE, APPROVED_SALE_OF } from "./approved.ts";
import { walkPositions, type PotFill } from "./books.ts";
import { feeCoinUsd, spendsOnFees } from "./fee-coin-said.ts";
import { QUANTITY_DECIMALS } from "./fill-key.ts";
import { recipeForTool } from "./recipes/index.ts";
import { centsToUsd, parseUnits, usdToCents } from "./usd.ts";

/** A specialist's pot as the permission gate weighs it. */
export interface Pot {
  /**
   * What it may still put into holdings on its own, in cents: its pot, less
   * what its open holdings cost, less any net loss it has taken, less buys
   * still on their way, less what its moves spent buying a chain's coin for
   * their fees. A gain stays out of reach until the owner raises the pot, and
   * a loss is never refilled from their other money.
   */
  readonly freeCashCents: bigint;
  /**
   * How much of each holding it may sell on its own, keyed by `fillIdentity`
   * in `QUANTITY_DECIMALS` units: a short's size counts like a long's. Empty
   * while one of its sells is still settling, since that sell's fill isn't
   * counted yet; less what a held sell may have sold (see specialistPot).
   */
  readonly holds: ReadonlyMap<string, bigint>;
}

/** The pot as the fills leave it; see `walkPositions` for how holdings follow them. */
export function potOf(input: {
  readonly potUsd: string;
  /** Oldest first. */
  readonly fills: readonly PotFill[];
  readonly inFlightBuysUsd: readonly string[];
  /** What each of its moves spent, or while it runs may spend, buying a chain's coin for its fees. */
  readonly feesUsd?: readonly string[];
  readonly sellSettling: boolean;
  /**
   * What held sells may already have sold, keyed like `holds`: each took at most what its card
   * approved, so that much of its holding is not the specialist's to sell again on its own.
   */
  readonly heldSales?: ReadonlyMap<string, bigint>;
}): Pot {
  const { positions, realized } = walkPositions(input.fills);
  const held = [...positions.values()].reduce((sum, position) => sum + position.cost, 0n);
  // What moves may spend, each at its most.
  const cents = (usds: readonly string[] = []) =>
    usds.reduce((sum, usd) => sum + usdToCents(usd, "up"), 0n);
  const spoken = cents(input.inFlightBuysUsd) + cents(input.feesUsd);
  return {
    freeCashCents: usdToCents(input.potUsd) - held - (realized < 0n ? -realized : 0n) - spoken,
    holds: new Map(
      input.sellSettling
        ? []
        : [...positions]
            .map(([key, { quantity }]) => {
              const held =
                (quantity < 0n ? -quantity : quantity) - (input.heldSales?.get(key) ?? 0n);
              return [key, held] as const;
            })
            .filter(([, held]) => held > 0n),
    ),
  };
}

/** A specialist's recorded fills, oldest first. */
export async function specialistFills(
  tx: Pick<Tx, "select">,
  specialistId: string,
): Promise<PotFill[]> {
  return tx
    .select({
      chain: fills.chain,
      instrument: fills.instrument,
      side: fills.side,
      quantity: fills.quantity,
      usdValue: fills.usdValue,
    })
    .from(fills)
    .where(eq(fills.specialistId, specialistId))
    .orderBy(asc(fills.createdAt), asc(fills.id));
}

/**
 * Held while cards are recorded, and while a move re-files a holding, so no
 * card can be recorded against a holding mid-move.
 */
export async function lockCards(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('auni:cards'))`);
}

/**
 * The specialist's pot as recorded now. Call it inside the transaction that
 * locked the specialist's row, so two plans can't both spend its free cash.
 */
export async function specialistPot(
  tx: Tx,
  specialist: Pick<SpecialistRow, "id" | "potUsd">,
): Promise<Pot> {
  const recorded = await specialistFills(tx, specialist.id);
  // Running legs have no fills yet: a buy's money is spoken for, and a sell's
  // quantity unknown, until they settle. Moving cash to where picks need it
  // spends none of it, though taking savings out still sells what is held.
  const running = await tx
    .select({
      tool: actions.tool,
      input: actions.input,
      amountUsd: actions.amountUsd,
      phase: actions.phase,
      details: actions.details,
    })
    .from(actions)
    .where(and(eq(actions.specialistId, specialist.id), eq(actions.status, "running")));
  // A purchase of a chain's coin for a move's fees is spending of the move it serves: counted
  // while that move runs, since it may yet buy, and for good once it has (see spendsOnFees).
  const bought = await tx
    .select({ details: actions.details })
    .from(actions)
    .where(and(eq(actions.specialistId, specialist.id), spendsOnFees));
  const sells = (row: (typeof running)[number]) =>
    recipeForTool(row.tool)?.direction?.(row.input) === "sell";
  const movesCash = (row: (typeof running)[number]) =>
    Boolean(recipeForTool(row.tool)?.readies?.(row.input));
  // A held move may wait on the owner for days, so it is counted as what it most likely did
  // rather than as still settling: a held buy's dollars stay spent, as any running buy's are,
  // and a held sell takes only what its card approved selling out of what the specialist may
  // sell on its own, where a sell still settling holds back all of it.
  const heldSale = (row: (typeof running)[number]) =>
    row.phase === "needs_owner" && sells(row) ? approvedSale(row.details) : null;
  const heldSales = new Map<string, bigint>();
  for (const sale of running.flatMap((row) => heldSale(row) ?? []))
    heldSales.set(sale.of, (heldSales.get(sale.of) ?? 0n) + sale.quantity);
  return potOf({
    potUsd: specialist.potUsd,
    fills: recorded,
    inFlightBuysUsd: running
      .filter((row) => !sells(row) && !movesCash(row))
      .map((row) => row.amountUsd),
    feesUsd: bought.flatMap(({ details }) => feeCoinUsd(details) ?? []),
    sellSettling: running.some((row) => sells(row) && !heldSale(row)),
    heldSales,
  });
}

/** The most a sell's card approved selling, and of which holding, in the units `holds` counts. */
function approvedSale(
  details: Record<string, string>,
): { readonly of: string; readonly quantity: bigint } | null {
  const of = details[APPROVED_SALE_OF];
  const quantity = details[APPROVED_SALE];
  return of && quantity ? { of, quantity: parseUnits(quantity, QUANTITY_DECIMALS) } : null;
}

/**
 * The pot of a specialist a holding leaves by `sale`: lowered by what the sale
 * frees of its cash, so it has no more to spend on its own than before. That
 * is what the holding cost, less any of a loss on it that its pot already
 * counted spent, never below nothing.
 */
export function potLeaving(potUsd: string, recorded: readonly PotFill[], sale: PotFill): string {
  const free = (fills: readonly PotFill[]) =>
    potOf({ potUsd, fills, inFlightBuysUsd: [], sellSettling: false }).freeCashCents;
  const left = usdToCents(potUsd) - (free([...recorded, sale]) - free(recorded));
  return centsToUsd(left > 0n ? left : 0n);
}
