import type { ActionRow } from "../db/schema.ts";
import { APPROVED_PROCEEDS } from "./approved.ts";
import { retryRefusal } from "./failure.ts";
import { ledgerAt } from "../apps/registry.ts";
import { feeCoinCash, pinned } from "./fee-coin-said.ts";
import type { CashPlace, Recipe } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";
import { usdToCents } from "./usd.ts";

/**
 * The order one proposal's legs run in, under its one tap. Money that has to
 * be gathered first moves before the picks it pays for: savings and a
 * venue account's free cash come out to a wallet, then cash moves between
 * wallets, then into a venue's account, then the picks run together. A stage
 * starts once no leg before it still runs; a move that didn't go through
 * stops the legs after it that spend the money it was to bring, so nothing is
 * bought with money that isn't there, and the rest still run.
 */

/** Stages in the order they run; a proposal without money moves is all picks. */
const FREES = 0;
const MOVES = 1;
const INTO_ACCOUNT = 2;
export const PICKS = 3;
/** How far ahead of its stage a move runs that buys a coin the moves beside it need (FeeCoin.ahead). */
const AHEAD = 0.5;

/** A proposal's leg as its order sees it. */
export interface StagedLeg {
  readonly id: string;
  readonly status: ActionRow["status"];
  /** Allowed and not yet claimed by a run. */
  readonly queued: boolean;
  readonly stage: number;
  /** Where a money move lands its cash. */
  readonly lands: CashPlace | null;
  /** Where the cash the leg spends sits. */
  readonly draws: CashPlace | null;
  readonly amountUsd: string;
  /** The least a money move lands, in dollars, when its card says (see APPROVED_PROCEEDS). */
  readonly landsAtLeastUsd?: string;
  /**
   * Cash its card spends beside `amountUsd`, buying a chain's coin for its fee with USDC: how
   * much, and from which chain's cash (see feeCoinCash).
   */
  readonly feeCash?: { readonly from: CashPlace; readonly usd: string };
}

/**
 * Where a move's cash comes from and goes, as a plan's funding weighs it: read the same off a
 * card as it is prepared and off one recorded, from what it pinned.
 */
export function cashOf(
  recipe: Recipe | undefined,
  input: Record<string, unknown>,
  details: Record<string, string>,
  amountUsd: string,
): Pick<StagedLeg, "lands" | "draws" | "amountUsd" | "landsAtLeastUsd" | "feeCash"> {
  const lands = recipe?.readies?.(input as never) ?? null;
  const least = lands ? details[APPROVED_PROCEEDS] : undefined;
  const feeCash = feeCoinCash(details);
  return {
    lands,
    draws: recipe?.fundedFrom?.({ input: input as never, details }) ?? null,
    amountUsd,
    ...(least === undefined ? {} : { landsAtLeastUsd: least }),
    ...(feeCash ? { feeCash } : {}),
  };
}

export function stagedLeg(
  row: Pick<ActionRow, "id" | "status" | "phase" | "tool" | "input" | "details" | "amountUsd"> &
    Partial<Pick<ActionRow, "txs">>,
): StagedLeg {
  const { feeCash, ...cash } = cashOf(
    recipeForTool(row.tool),
    row.input,
    row.details,
    row.amountUsd,
  );
  // A card buys the coin for its fee once: a move that kept its purchase has that cash spent
  // already, so a run of it again needs none of it.
  const bought = row.txs?.some((tx) => tx.buysFees) ?? false;
  return {
    id: row.id,
    status: row.status,
    queued: row.phase === "queued",
    // A move buying its card's SOL for the moves beside it runs just ahead of them.
    stage: stageOf(cash) - (pinned(row.details)?.ahead ? AHEAD : 0),
    ...cash,
    ...(feeCash && !bought ? { feeCash } : {}),
  };
}

/** The stage a leg runs in, by where its cash comes from and goes (see the top). */
export function stageOf(cash: Pick<StagedLeg, "draws" | "lands">): number {
  const { lands } = cash;
  return lands === null ? PICKS : frees(cash) ? FREES : ledgerAt(lands) ? INTO_ACCOUNT : MOVES;
}

/** A move that takes cash out to a wallet from somewhere that isn't one: savings, or a venue's account. */
export function frees({ draws, lands }: Pick<StagedLeg, "draws" | "lands">): boolean {
  return lands !== null && !ledgerAt(lands) && (draws === null || ledgerAt(draws) !== undefined);
}

type NextStep =
  | { readonly kind: "start"; readonly stage: number; readonly ids: readonly string[] }
  | { readonly kind: "stop"; readonly ids: readonly string[] }
  | { readonly kind: "none" };

/**
 * Of `legs`, those a `failed` leg strands, directly or through another it strands: a leg in an
 * earlier stage was to land the cash they spend, or, where it isn't known what they spend from,
 * any leg in an earlier stage.
 */
function stranded(legs: readonly StagedLeg[], failed: readonly StagedLeg[]): StagedLeg[] {
  const blocked = [...failed];
  return [...legs]
    .sort((a, b) => a.stage - b.stage)
    .filter((leg) => {
      const strands = blocked.some(
        (before) => before.stage < leg.stage && (leg.draws === null || before.lands === leg.draws),
      );
      if (strands) blocked.push(leg);
      return strands;
    });
}

/** What to do now: stop what can no longer run (see stranded), start the next stage, or nothing yet. */
export function nextStep(legs: readonly StagedLeg[]): NextStep {
  const unstarted = legs.filter((leg) => leg.queued);
  if (unstarted.length === 0) return { kind: "none" };
  const ended = legs.filter((leg) => leg.status !== "done" && leg.status !== "running");
  const stopped = stranded(unstarted, ended);
  if (stopped.length > 0) return { kind: "stop", ids: stopped.map((leg) => leg.id) };
  const stage = Math.min(...unstarted.map((leg) => leg.stage));
  if (legs.some((leg) => leg.stage < stage && leg.status === "running")) return { kind: "none" };
  return {
    kind: "start",
    stage,
    ids: unstarted.filter((leg) => leg.stage === stage).map((leg) => leg.id),
  };
}

/**
 * What a stage's legs spend from places that earlier moves landed money in,
 * in cents per place: the stage waits until they hold it, since a bridge or
 * deposit that timed out waiting to land is done before its money arrives.
 */
export function awaitedCash(legs: readonly StagedLeg[], stage: number): Map<CashPlace, bigint> {
  const landed = new Set(
    legs.flatMap((leg) =>
      leg.stage < stage && leg.status === "done" && leg.lands ? [leg.lands] : [],
    ),
  );
  const awaited = new Map<CashPlace, bigint>();
  for (const leg of legs) {
    if (leg.stage !== stage || !leg.draws || !landed.has(leg.draws)) continue;
    awaited.set(leg.draws, (awaited.get(leg.draws) ?? 0n) + usdToCents(leg.amountUsd));
  }
  return awaited;
}

/** A proposal's leg as Try again weighs it. */
export type RetryLeg = Parameters<typeof stagedLeg>[0] & Parameters<typeof retryRefusal>[0];

/**
 * The legs one tap on a card's Try again runs again: every failed leg that
 * can run again as it is (see retryRefusal), but those whose price is now
 * past what was approved (`pricedPast`, as quoted again), and each leg
 * stopped behind a failed move once no failed move left out strands it (see
 * stranded), so it isn't only stopped again. Null while any leg still runs, when
 * none can, or when a stopped leg it would free can't run on a tap (it needs
 * the owner's proof): freeing the moves without it would only strand the cash
 * they move for it.
 */
export function legsToRetry(
  rows: readonly RetryLeg[],
  pricedPast: ReadonlySet<string>,
): string[] | null {
  if (rows.some((row) => row.status === "running")) return null;
  const failed = rows.filter((row) => row.status === "failed");
  const stopped = failed.filter((row) => row.failureKind === "stopped");
  const ended = failed.filter((row) => row.failureKind !== "stopped");
  const again = ended.filter((row) => retryRefusal(row) === null && !pricedPast.has(row.id));
  if (again.length === 0) return null;
  const left = ended.filter((row) => !again.includes(row)).map(stagedLeg);
  const still = new Set(stranded(stopped.map(stagedLeg), left).map((leg) => leg.id));
  const freed = stopped.filter((row) => !still.has(row.id));
  if (freed.some((row) => retryRefusal(row) !== null)) return null;
  return [...again, ...freed].map((row) => row.id);
}
