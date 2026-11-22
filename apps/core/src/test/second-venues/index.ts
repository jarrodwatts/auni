import type { App } from "../../apps/contract.ts";
import type * as Generated from "../../apps/index.generated.ts";
import type * as Order from "../../apps/order.ts";
import bridge, { BRIDGE } from "./bridge.ts";
import perps from "./perps.ts";
import predictions from "./predictions.ts";
import reader from "./reader.ts";
import savings from "./savings.ts";
import solanaRoute, { SOLANA_ROUTE } from "./solana-route.ts";
import swapRoute from "./swap-route.ts";
import vault from "./vault.ts";

/**
 * A second venue of each kind, a vault that prices its own shares, and a reader for a contract
 * the agent builds transactions for, each written as an app
 * folder would be, against contract.ts and core's leaf files alone. second-venues.test.ts and its .db twin install them beside the real apps
 * with no edit to core: if one of these needed a line of core to change, a real one would too.
 */
export const SECOND_VENUES: readonly App[] = [
  bridge,
  perps,
  predictions,
  reader,
  savings,
  solanaRoute,
  swapRoute,
  vault,
];

/** The app list as `pnpm gen` writes it with these folders added, first, as folders whose ids sort first would be. */
export function withSecondVenues(generated: typeof Generated): typeof Generated {
  return { ...generated, APPS: [...SECOND_VENUES, ...generated.APPS] as never };
}

/**
 * apps/order.ts with the line the second bridge and the second Solana route each add to it. A
 * folder's place in the alphabet gives neither anything: each is asked first, so core's own
 * moves and its Solana listings go through it, only because this says so.
 */
export function withTheirOrder(order: typeof Order): typeof Order {
  const { bridge, solana } = order.ASKED_FIRST;
  return {
    ...order,
    ASKED_FIRST: {
      ...order.ASKED_FIRST,
      bridge: [BRIDGE, ...bridge],
      solana: [SOLANA_ROUTE, ...solana],
    } as never,
  };
}
