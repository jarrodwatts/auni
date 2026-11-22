import { defineApp } from "../contract.ts";
import { hyperliquidFreeCents } from "./account.ts";
import { perpDetail } from "./detail.ts";
import { perpFace, positionFace } from "./face.ts";
import { findPerps } from "./find.ts";
import { readHyperliquid } from "./holdings.ts";
import { hyperliquidMarkets } from "./markets.ts";
import { hyperliquidOpenOrders } from "./open-orders.ts";
import about from "./about.ts";
import { hyperliquidCancelOrder } from "./cancel.ts";
import { hyperliquidOrder } from "./order.ts";
import { hyperliquidClose, hyperliquidSetStops } from "./position.ts";
import { problems } from "./problems.ts";
import { hyperliquidPrices } from "./prices.ts";
import { hyperliquidStatement } from "./statement.ts";
import { hyperliquidDeposit, hyperliquidWithdraw, WITHDRAWAL_FEE_USD } from "./transfers.ts";

/** Hyperliquid perps: orders, stops, cancels and closes, and USDC in and out of the account. */
export default defineApp({
  about,
  guide: "Perps trade on Hyperliquid.",
  lookups: () => [hyperliquidMarkets, hyperliquidOpenOrders],
  moves: [
    hyperliquidOrder,
    hyperliquidClose,
    hyperliquidSetStops,
    hyperliquidCancelOrder,
    hyperliquidDeposit,
    hyperliquidWithdraw,
  ],
  // An order sets its market's leverage on the account before it places, so two at once could
  // each open at the other's leverage.
  oneAtATime: true,
  problems,
  // The account is a ledger of Hyperliquid's own, on no chain: its positions and its free cash
  // are filed under this app's id, and money goes in and out by a move of its own.
  account: {
    kept: { ledger: readHyperliquid },
    margined: true,
    prices: hyperliquidPrices,
    face: positionFace,
    market: perpFace,
    moneyIn: hyperliquidDeposit,
    moneyOut: hyperliquidWithdraw,
    cash: { kind: "ledger", free: hyperliquidFreeCents, outFeeUsd: WITHDRAWAL_FEE_USD },
    statement: hyperliquidStatement,
    detail: (subject, action) =>
      subject.kind === "perp" ? perpDetail(subject, action) : Promise.resolve(null),
    find: findPerps,
  },
});
