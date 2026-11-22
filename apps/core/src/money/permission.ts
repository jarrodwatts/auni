import { staysYours, type Effect } from "./effect.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import type { Pot } from "./pot.ts";
import type { Sale } from "./recipe.ts";
import { parseUnits, usdToCents } from "./usd.ts";

/** One leg of a plan, as the gate weighs it. */
export interface GateLeg {
  readonly direction: "buy" | "sell" | null;
  /** What it gives, gets and grants, as its card shows it. */
  readonly effect: Effect;
  /** Code-computed dollars the leg spends. */
  readonly amountUsd: string;
  /** What a sell sells and how much, resolved the way execute sizes it; null when the recipe can't say. */
  readonly sells: Sale | null;
  /** Buys a token with no market price, or loses past its venue's limit on fill. */
  readonly unpriced: boolean;
  /** Dollars its card spends beyond `amountUsd` buying a chain's coin for its fees; null for none. */
  readonly feesUsd: string | null;
}

/**
 * The approval ladder's last rung: when a move needs no tap at all. A thread
 * set to ask first always asks. A thread set to act on its own within a budget
 * runs a plan only when every leg is a buy or a sell, its effect keeps the
 * money the owner's with no new power over it (see staysYours), and execute's
 * fresh effect still matches the card. Within that, the sells together sell no
 * more of each holding than this thread holds, and the buys together fit its
 * free cash, with whatever any leg's card spends buying a chain's coin for its
 * fees (fee-coin.ts): that is spending like any other, so a move that can't
 * afford it inside the budget asks. A leg code sized at nothing, or a buy of a
 * token with no market price or in a thin market, asks too. Sells bring money
 * back, so they fit even when free cash is below zero, but never of the owner's
 * other money: selling past the thread's own share asks.
 */
export function permissionDecision(input: {
  /** Null outside any thread (a withdrawal from Settings). */
  readonly thread: ({ readonly actsOnItsOwn: boolean } & Pot) | null;
  readonly legs: readonly GateLeg[];
}): "run" | "ask" {
  const { thread } = input;
  if (!thread?.actsOnItsOwn) return "ask";
  let spends = 0n;
  const selling = new Map<string, bigint>();
  for (const leg of input.legs) {
    if (!staysYours(leg.effect) || leg.direction === null || leg.unpriced) return "ask";
    spends += usdToCents(leg.feesUsd ?? "0", "up");
    if (leg.direction === "sell") {
      if (!leg.sells) return "ask";
      const key = fillIdentity(leg.sells);
      const quantity = parseUnits(leg.sells.quantity, QUANTITY_DECIMALS);
      const total = (selling.get(key) ?? 0n) + quantity;
      if (quantity === 0n || total > (thread.holds.get(key) ?? 0n)) return "ask";
      selling.set(key, total);
      continue;
    }
    const cents = usdToCents(leg.amountUsd);
    if (cents === 0n) return "ask";
    spends += cents;
  }
  return spends === 0n || spends <= thread.freeCashCents ? "run" : "ask";
}
