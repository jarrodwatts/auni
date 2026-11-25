import { EVM_CASH_KEYS } from "@auni/shared";

import { heldLabel } from "../../money/format.ts";
import { defineApp } from "../contract.ts";
import { aaveMarket, aaveSupply, aaveWithdraw } from "./aave.ts";
import about from "./about.ts";
import { problems } from "./problems.ts";

/** Aave V3 savings: USDC in and out of its pools on Auni's EVM cash chains. */
export default defineApp({
  about,
  guide:
    "Savings are Aave USDC on Monad, Base, Arbitrum or Polygon, each market at its own variable rate, so save on the chain where the cash already sits rather than bridging for a small difference. The supply card shows the owner its market's rate now; before you quote one yourself, read it live with a search rather than recalling it.",
  moves: [aaveSupply, aaveWithdraw],
  problems,
  // Savings are the market's aUSDC in the owner's own wallet, each worth a dollar, so they count
  // as cash that earns until it is taken out.
  account: {
    kept: {
      wallet: EVM_CASH_KEYS.flatMap((chain) => {
        const market = aaveMarket(chain);
        return market ? [{ chain, instrument: market.aUsdc, symbol: "aUSDC" }] : [];
      }),
    },
    face: async (holding) => ({
      name: `Savings on ${about.name}`,
      detail: `${heldLabel(holding.quantity)} ${holding.symbol}`,
      logoUrl: null,
    }),
    moneyIn: aaveSupply,
    moneyOut: aaveWithdraw,
    cash: {
      kind: "savings",
      token(chain) {
        const market = aaveMarket(chain);
        return market && { pool: market.pool, token: market.aUsdc, symbol: "aUSDC" };
      },
    },
  },
});
