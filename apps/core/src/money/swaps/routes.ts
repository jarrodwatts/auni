import type { AppAbout } from "@auni/shared";

import type { SwapRoute } from "../../apps/contract.ts";
import type { EvmQuoteRequest, EvmRoute } from "./evm.ts";
import { within } from "./shared.ts";

// Apps quote swaps through this file, and the registry loads every app, so the routes are
// looked up when first asked for: a load-time import here would load all of them first.
const swapRoutes = async () => (await import("../../apps/registry.ts")).filling("swaps");

// Each route an app provides (see SwapRoute) quotes the exact trade asked for, or throws its
// plain reason. `buyAmount` is what the wallet gets after every fee the venue takes. With a taker,
// the route carries `send`, which sends from the owner's wallet and returns only once the trade is
// final: what arrived, or 0n with a note saying why nothing filled and that nothing left the
// wallet. Steps that aren't the move itself (an approval, a refund) are `setup`.

/**
 * A stock trade Monad can't quote moves to Solana, so its card or execute doesn't wait on a slow
 * venue; one that can quote answers in a few seconds.
 */
const STOCK_QUOTE_WAIT_MS = 10_000;

/** The best route for a Monad stock trade, from every route there is. */
export async function quoteStock(request: EvmQuoteRequest): Promise<EvmRoute> {
  return best(await swapRoutes(), request, STOCK_QUOTE_WAIT_MS);
}

/**
 * The best route for any other EVM swap, from the routes that trade any pair. Nothing else could
 * take it, so each route gets its own time limits.
 */
export async function quoteSwap(request: EvmQuoteRequest): Promise<EvmRoute> {
  return best(
    (await swapRoutes()).filter(({ part }) => part.trades === "any"),
    request,
  );
}

/**
 * Every route is asked at once, and the one paying most wins; with `waitMs`, a
 * route that hasn't answered by then is passed over. Throws when none can
 * quote, naming each route's reason.
 */
async function best(
  routes: readonly { readonly about: AppAbout; readonly part: SwapRoute }[],
  request: EvmQuoteRequest,
  waitMs?: number,
): Promise<EvmRoute> {
  const answers = await Promise.all(
    routes.map(({ about, part }) =>
      (waitMs === undefined ? part.quote(request) : within(part.quote(request), waitMs)).then(
        (route) => ({ route }),
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          return { reason: `${about.name}: ${reason.replace(/\.$/u, "")}` };
        },
      ),
    ),
  );
  const top = answers.reduce<EvmRoute | null>(
    (top, answer) =>
      "route" in answer && (!top || answer.route.buyAmount > top.buyAmount) ? answer.route : top,
    null,
  );
  if (top) return top;
  throw new Error(
    `${answers.map((answer) => ("reason" in answer ? answer.reason : "")).join("; ")}.`,
  );
}
