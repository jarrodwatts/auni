import type * as Shared from "@auni/shared";
import type { AppAbout } from "@auni/shared";

// Each second venue's meta, as plain data, as an app's about.ts is: `pnpm gen` copies those into
// @auni/shared for the web and for core's names, which withTheirListings stands in for. It loads
// nothing, so @auni/shared's mock can read it without loading @auni/shared.

const copy = ["Moving", "Moved", "Couldn’t move"] as const;

export const ABOUT = {
  bridge: {
    id: "fake-bridge",
    name: "Fake Bridge",
    tools: { fake_bridge_usdc: { kind: "money", copy } },
  },
  perps: {
    id: "fake-perps",
    name: "Fake Perps",
    tools: { fake_perps_deposit: { kind: "money", copy }, fake_perps_fill: { kind: "recorded" } },
  },
  predictions: {
    id: "fake-predictions",
    name: "Fake Predictions",
    tools: { fake_predictions_payout: { kind: "recorded" } },
  },
  reader: { id: "fake-staking", name: "Fake Staking" },
  savings: { id: "fake-savings", name: "Fake Savings" },
  solanaRoute: { id: "fake-solana", name: "Fake Solana" },
  swapRoute: { id: "fake-swap", name: "Fake Swap" },
  vault: { id: "fake-vault", name: "Fake Vault" },
} as const satisfies Record<string, AppAbout>;

/** @auni/shared as `pnpm gen` writes it with these folders added: their names, by id. */
export function withTheirListings(shared: typeof Shared): typeof Shared {
  const listed: readonly AppAbout[] = Object.values(ABOUT);
  return {
    ...shared,
    appListing: (id) => listed.find((meta) => meta.id === id) ?? shared.appListing(id),
  };
}
