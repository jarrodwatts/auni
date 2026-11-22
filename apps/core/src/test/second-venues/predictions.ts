import type { VenueToolName } from "@auni/shared";
import { vi } from "vitest";

import { defineApp, type AccountHolding, type Payout } from "../../apps/contract.ts";
import type { FillKey } from "../../money/fill-key.ts";
import { ABOUT } from "./about.ts";

/**
 * A second prediction market: its shares live on Base, by a numeric id, and $7 of its collateral
 * waits there as Base cash.
 */
export const PREDICTIONS = ABOUT.predictions.id;
export const COLLATERAL = "0x000000000000000000000000000000000000fc01";
export const SNOW: FillKey = { chain: "base", instrument: "777" };
export const PAYOUT_TOOL = "fake_predictions_payout" as VenueToolName;

/** What it has paid out, which a test sets. */
export const predictionPayouts = vi.fn(async (): Promise<readonly Payout[]> => []);

/** What it keeps for the owner on Base: three shares of one outcome, and its collateral. */
const held = async (): Promise<AccountHolding[]> => [
  {
    ...SNOW,
    symbol: "Will it snow?: Yes",
    baseUnits: 3n * 10n ** 18n,
    decimals: 18,
    priceId: null,
    usdValue: "1.50",
    cash: false,
  },
  {
    chain: "base",
    instrument: COLLATERAL,
    symbol: "fUSD",
    baseUnits: 7_000_000n,
    decimals: 6,
    priceId: null,
    cash: true,
  },
];
const owns = (key: FillKey) => key.chain === "base" && /^\d+$/u.test(key.instrument);
const prices = { live: async () => 0.5, history: async () => [] };

export default defineApp({
  about: ABOUT.predictions,
  guide: "Fake predictions trade on Fake Predictions.",
  account: {
    kept: { chains: ["base"], read: held, owns },
    prices,
    face: async (holding) => {
      const [market, outcome] = holding.symbol.split(": ");
      return {
        name: market!,
        detail: `${outcome}, ${holding.quantity} shares on Fake Predictions`,
        logoUrl: null,
      };
    },
    moneyIn: "A buy takes its cash from the wallet.",
    moneyOut: "Fake Predictions has no way to take money out.",
    cash: { kind: "chain", chain: "base", tokens: [COLLATERAL], free: async () => 700n },
    payouts: { tool: PAYOUT_TOOL, read: predictionPayouts },
    detail: async () => null,
    find: async () => [],
  },
});
