import { takesWireSchema, type ThreadId } from "@auni/shared";

import { requestCore } from "@/lib/core";

import { toHolding } from "./portfolio";
import { dollarsToBaseUnits } from "./usdc";
import type { Holding } from "./views";

/** A take: a chat that holds positions, with its share of the money (core's GET /takes). */
export interface Take {
  readonly threadId: ThreadId;
  readonly title: string;
  /** What its holdings are worth now, in USDC base units. */
  readonly value: bigint;
  /**
   * What they made since they were bought, signed, in base units, and as a percent of what they
   * cost; null when nothing records what any of them cost.
   */
  readonly change: { readonly amount: bigint; readonly percent: number } | null;
  /** Largest first. */
  readonly holdings: readonly Holding[];
}

export interface Takes {
  /** Largest first. */
  readonly takes: readonly Take[];
  /** What no take holds, largest first. */
  readonly loose: readonly Holding[];
}

export async function getTakes(signal?: AbortSignal): Promise<Takes> {
  const body = takesWireSchema.parse(await requestCore("takes", { method: "GET", signal }));
  return {
    takes: body.takes.map((take) => ({
      threadId: take.threadId,
      title: take.title,
      value: dollarsToBaseUnits(take.valueUsd),
      change: takeChange(take.changeUsd, take.costUsd),
      holdings: take.holdings.map(toHolding),
    })),
    loose: body.loose.map(toHolding),
  };
}

/** What a take made, and that over what it cost as a percent; null when either is unknown. */
function takeChange(changeUsd: string | null, costUsd: string | null): Take["change"] {
  if (changeUsd === null || costUsd === null) return null;
  const amount = dollarsToBaseUnits(changeUsd);
  const cost = dollarsToBaseUnits(costUsd);
  return { amount, percent: cost > 0n ? (Number(amount) / Number(cost)) * 100 : 0 };
}
