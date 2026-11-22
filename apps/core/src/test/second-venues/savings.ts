import { defineApp, type SavingsToken } from "../../apps/contract.ts";
import { ABOUT } from "./about.ts";

/** A second savings venue, with a market on Base and one on Monad. */
export const SAVINGS = ABOUT.savings.id;
export const SAVINGS_TOKEN = "0x000000000000000000000000000000000000fa02";

const MARKETS: Readonly<Record<string, SavingsToken>> = {
  base: {
    pool: "0x000000000000000000000000000000000000fa01",
    token: SAVINGS_TOKEN,
    symbol: "fsUSDC",
  },
  monad: {
    pool: "0x000000000000000000000000000000000000fa03",
    token: "0x000000000000000000000000000000000000fa04",
    symbol: "fsUSDC",
  },
};

export default defineApp({
  about: ABOUT.savings,
  account: {
    kept: {
      wallet: (["base", "monad"] as const).map((chain) => ({
        chain,
        instrument: MARKETS[chain]!.token,
        symbol: MARKETS[chain]!.symbol,
      })),
    },
    face: async () => ({ name: "Cash", detail: "Savings on Fake Savings", logoUrl: null }),
    moneyIn: "Fake Savings takes deposits on its own site.",
    moneyOut: "Fake Savings pays out on its own site.",
    cash: { kind: "savings", token: (chain) => MARKETS[chain] ?? null },
  },
});
