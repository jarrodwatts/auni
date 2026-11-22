import { defineApp } from "../contract.ts";
import { chanceDetail } from "./detail.ts";
import { polymarketFacts } from "./facts.ts";
import { findPredictions } from "./find.ts";
import { COLLATERAL, outcomeFace, readPolymarket } from "./holdings.ts";
import { isOutcome } from "./keys.ts";
import { polymarketMarkets } from "./markets.ts";
import about from "./about.ts";
import { polymarketOrder } from "./order.ts";
import { PAYOUT_TOOL, polymarketPayouts } from "./payouts.ts";
import { polymarketPrices } from "./prices.ts";
import { problems } from "./problems.ts";
import { polymarketRegion } from "./region.ts";
import { relayed } from "./relayer.ts";
import { tryBuilder } from "./http.ts";
import { polymarketWithdraw } from "./withdraw.ts";
import { depositWallet, polymarketCash } from "./wallet.ts";

/** Polymarket prediction markets: orders on its book from the owner's deposit wallet, and its cash brought home. */
export default defineApp({
  about,
  guide: "Predictions trade on Polymarket.",
  lookups: () => [polymarketMarkets],
  moves: [polymarketOrder, polymarketWithdraw],
  // Its relayer takes one transaction per wallet at a time and refuses the next while one is out.
  oneAtATime: true,
  // It goes by where this machine is: from some places it takes no new bets.
  noNewPositions: polymarketRegion,
  problems,
  facts: () => polymarketFacts(),
  async addresses(chain, owner) {
    if (chain !== "polygon") return new Map();
    const { address } = await depositWallet(owner);
    return new Map([[address.toLowerCase(), "their Polymarket wallet"]]);
  },
  // Positions and collateral live in the owner's deposit wallet on Polygon, not their own.
  account: {
    kept: { chains: ["polygon"], read: (owner) => readPolymarket(owner), owns: isOutcome },
    prices: polymarketPrices,
    face: outcomeFace,
    moneyIn:
      "A buy spends the cash already in your Polymarket wallet first, then takes the rest from " +
      "your own wallet on Polygon.",
    moneyOut: polymarketWithdraw,
    cash: {
      kind: "chain",
      chain: "polygon",
      tokens: COLLATERAL,
      // Its collateral has six decimals, and a part of a cent is never counted as spendable.
      free: async (owner) => (await polymarketCash(owner)) / 10_000n,
    },
    payouts: { tool: PAYOUT_TOOL, read: polymarketPayouts },
    detail: (subject) =>
      subject.kind === "outcome" ? chanceDetail(subject) : Promise.resolve(null),
    find: findPredictions,
  },
  tryKey: tryBuilder,
  async relayed(id) {
    const found = await relayed(id);
    return found === "pending" || !("failed" in found) ? found : "failed";
  },
});
