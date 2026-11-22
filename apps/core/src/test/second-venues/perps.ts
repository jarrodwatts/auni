import type { ActionToolName, VenueToolName } from "@auni/shared";
import { vi } from "vitest";
import { z } from "zod";

import { defineApp, type Found, type AccountHolding } from "../../apps/contract.ts";
import type { Recipe } from "../../money/recipe.ts";
import { ABOUT } from "./about.ts";

/** A second perps venue: its account is the place "fake-perps", holding $12.34 and a long. */
export const PERPS = ABOUT.perps.id;

const input = { amountUsd: z.number().positive() };

const deposit: Recipe<typeof input> = {
  // `pnpm gen` lists a real app's tools in @auni/shared; this one stays out of the list.
  tool: "fake_perps_deposit" as ActionToolName,
  description: "Move USDC from the owner's Base wallet into their Fake Perps account.",
  input,
  venue: PERPS,
  fundedFrom: () => "base",
  readies: () => PERPS,
  about: () => ({ kind: "cash", at: PERPS }),
  async describe({ amountUsd }) {
    return {
      summary: `Move $${amountUsd} into Fake Perps`,
      amountUsd: amountUsd.toFixed(2),
      // Cash that stays the owner's, read back in the account: a tap allows it, as a real deposit.
      effect: {
        gives: [{ text: `$${amountUsd} of USDC on Base` }],
        gets: [{ text: `$${amountUsd} in your Fake Perps account`, lands: "in the account" }],
        grants: [],
      },
    };
  },
  execute: (context) => perpsDeposit(context),
};

/** What the deposit does once allowed: nothing is sent, unless a test has it send. */
export const perpsDeposit = vi.fn<Recipe<typeof input>["execute"]>(async () => {
  throw new Error("A fake sends nothing.");
});

/** What its statement reads, which a test may change. */
export const perpsStatement = vi.fn(async (_since: number | null) => ({
  entries: [],
  through: 1_000,
}));

const CASH: AccountHolding = {
  chain: PERPS,
  instrument: "USDC",
  symbol: "USDC",
  baseUnits: 12_340_000n,
  decimals: 6,
  priceId: null,
  cash: true,
};

/** What the account holds, which a test may change: its free cash, and one open long. */
export const perpsHoldings = vi.fn(async (_owner: string): Promise<AccountHolding[]> => [
  CASH,
  {
    chain: PERPS,
    instrument: "FAKE",
    symbol: "FAKE",
    baseUnits: 2n * 10n ** 18n,
    decimals: 18,
    priceId: null,
    usdValue: "5.00",
    cash: false,
    leverage: 2,
  },
]);

/** The one market it lists. */
const FAKE_INDEX: Found = {
  // A word of its own: core lists whatever kind an app gives.
  kind: "index",
  tool: "fake_perps_deposit" as ActionToolName,
  name: "Fake Index",
  ticker: "FAKE",
  chain: PERPS,
  identifier: "FAKE",
  price: 42,
  liquidityUsd: null,
  volume24hUsd: 1_000_000,
  logoUrl: null,
};

/** The account with its long closed: only its free cash. */
export const PERPS_CASH_ONLY: AccountHolding[] = [CASH];

export default defineApp({
  about: ABOUT.perps,
  guide: "Fake perps trade on Fake Perps.",
  moves: [deposit],
  account: {
    kept: { ledger: (owner) => perpsHoldings(owner) },
    margined: true,
    prices: { live: async () => 42, history: async () => [] },
    face: async (holding) => ({
      name: `${holding.instrument} Index ${holding.leverage}x ${holding.short ? "short" : "long"}`,
      detail: `${holding.quantity} ${holding.instrument} on Fake Perps`,
      logoUrl: "fake.svg",
    }),
    market: async (market) => ({ name: `${market} Index`, ticker: market, logoUrl: "fake.svg" }),
    moneyIn: deposit,
    moneyOut: "Fake Perps has no way to take money out.",
    cash: { kind: "ledger", free: async () => 1_234n, outFeeUsd: 2 },
    statement: () => ({ tool: "fake_perps_fill" as VenueToolName, read: perpsStatement }),
    detail: async () => null,
    find: async () => [FAKE_INDEX],
  },
});
