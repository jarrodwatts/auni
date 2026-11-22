import { describe, expect, it } from "vitest";

import {
  evmTokenKey,
  fillIdentity,
  QUANTITY_DECIMALS,
  solanaMintKey,
  type FillKey,
} from "./fill-key.ts";
import type { Effect } from "./effect.ts";
import { permissionDecision, type GateLeg } from "./permission.ts";
import { parseUnits } from "./usd.ts";

const NVDA = solanaMintKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
/** A trade: cash for a holding, both in the wallet. */
const trade: Effect = {
  gives: [{ text: "$1.00 of USDC" }],
  gets: [{ text: "about 0.005 NVDAx" }],
  grants: [],
};
const buy = (amountUsd: string): GateLeg => ({
  direction: "buy",
  effect: trade,
  amountUsd,
  sells: null,
  unpriced: false,
  feesUsd: null,
});
const selling = (quantity: string, key: FillKey = NVDA): GateLeg => ({
  direction: "sell",
  effect: trade,
  amountUsd: "0",
  sells: { ...key, quantity },
  unpriced: false,
  feesUsd: null,
});
const sell = selling("2");
/** What the specialist holds, keyed and counted as pot.ts builds it. */
const holding = (key: FillKey, quantity: string) =>
  new Map([[fillIdentity(key), parseUnits(quantity, QUANTITY_DECIMALS)]]);
const holdsNvda = holding(NVDA, "2");
const acting = { actsOnItsOwn: true, freeCashCents: 10_000n, holds: holdsNvda };

describe("permissionDecision", () => {
  it("always asks in a chat", () => {
    expect(permissionDecision({ specialist: null, legs: [buy("1")] })).toBe("ask");
  });

  it("always asks in a specialist set to ask first", () => {
    const specialist = { actsOnItsOwn: false, freeCashCents: 10_000n, holds: holdsNvda };
    expect(permissionDecision({ specialist, legs: [sell] })).toBe("ask");
  });

  it("runs buys that fit the specialist's free cash to the cent, and asks past it", () => {
    const legs = [buy("40"), buy("35.50"), buy("24.50")];
    expect(permissionDecision({ specialist: acting, legs })).toBe("run");
    expect(permissionDecision({ specialist: acting, legs: [...legs, buy("0.01")] })).toBe("ask");
  });

  it("counts what a card buys for its fees as spending of the move, so both fit the pot or it asks", () => {
    const withFees = (leg: GateLeg, feesUsd: string): GateLeg => ({ ...leg, feesUsd });
    // $99.75 and a quarter for fees fits $100 to the cent; a cent more of either asks.
    expect(permissionDecision({ specialist: acting, legs: [withFees(buy("99.75"), "0.25")] })).toBe(
      "run",
    );
    expect(permissionDecision({ specialist: acting, legs: [withFees(buy("99.75"), "0.26")] })).toBe(
      "ask",
    );
    // The verifier's case: a $2 buy from a $2 pot whose card also spends $3 on the coin.
    const small = { ...acting, freeCashCents: 200n };
    expect(permissionDecision({ specialist: small, legs: [buy("2")] })).toBe("run");
    expect(permissionDecision({ specialist: small, legs: [withFees(buy("2"), "3.00")] })).toBe(
      "ask",
    );
    // A sale brings money back, but what its card spends on fees still comes out of the pot.
    const spent = { ...acting, freeCashCents: 0n };
    expect(permissionDecision({ specialist: spent, legs: [sell] })).toBe("run");
    expect(permissionDecision({ specialist: spent, legs: [withFees(sell, "0.25")] })).toBe("ask");
    expect(permissionDecision({ specialist: acting, legs: [withFees(sell, "0.25")] })).toBe("run");
  });

  it("asks for any buy when free cash is gone", () => {
    const specialist = { actsOnItsOwn: true, freeCashCents: -500n, holds: holdsNvda };
    expect(permissionDecision({ specialist, legs: [buy("1")] })).toBe("ask");
  });

  it("runs sells whatever the free cash, and counts only the buys beside them", () => {
    const broke = { actsOnItsOwn: true, freeCashCents: 0n, holds: holdsNvda };
    expect(permissionDecision({ specialist: broke, legs: [sell] })).toBe("run");
    // A pot lowered below what its holdings cost still sells what it holds.
    const underwater = { ...broke, freeCashCents: -500n };
    expect(permissionDecision({ specialist: underwater, legs: [sell] })).toBe("run");
    expect(permissionDecision({ specialist: acting, legs: [sell, buy("100")] })).toBe("run");
  });

  it("runs a sell of up to what the specialist holds, and asks past it", () => {
    const decide = (legs: GateLeg[]) => permissionDecision({ specialist: acting, legs });
    expect(decide([selling("1.5")])).toBe("run");
    expect(decide([selling("2")])).toBe("run");
    // A "sell all" that would also take the owner's shares held outside it.
    expect(decide([selling("2.000001")])).toBe("ask");
    // Two legs of the same holding count together.
    expect(decide([selling("1.5"), selling("1")])).toBe("ask");
  });

  it("asks for a sell code sized at nothing", () => {
    expect(permissionDecision({ specialist: acting, legs: [selling("0")] })).toBe("ask");
  });

  it("asks before selling anything the specialist doesn't hold", () => {
    const sol = solanaMintKey("So11111111111111111111111111111111111111112");
    expect(permissionDecision({ specialist: acting, legs: [selling("1", sol)] })).toBe("ask");
    expect(permissionDecision({ specialist: acting, legs: [{ ...sell, sells: null }] })).toBe(
      "ask",
    );
  });

  it("knows a holding however its address is cased", () => {
    const token = "0x35a73BAcb179d3740395A3ceCc87FF2e581d6042";
    const specialist = { ...acting, holds: holding(evmTokenKey("monad", token), "10") };
    const legs = [selling("10", evmTokenKey("monad", token.toLowerCase()))];
    expect(permissionDecision({ specialist, legs })).toBe("run");
  });

  it("closes a perp the specialist holds, short or long, up to its size", () => {
    const tsla = { chain: "hyperliquid", instrument: "xyz:TSLA" };
    const specialist = { ...acting, holds: holding(tsla, "0.5") };
    const decide = (legs: GateLeg[]) => permissionDecision({ specialist, legs });
    expect(decide([selling("0.5", tsla)])).toBe("run");
    expect(decide([selling("0.8", tsla)])).toBe("ask");
    expect(decide([selling("0.1", { chain: "hyperliquid", instrument: "BTC" })])).toBe("ask");
  });

  it("asks for a buy code couldn't size", () => {
    expect(permissionDecision({ specialist: acting, legs: [buy("0")] })).toBe("ask");
  });

  it("asks for a buy of a token with no market price, even one that fits", () => {
    const unpriced: GateLeg = { ...buy("1"), unpriced: true };
    expect(permissionDecision({ specialist: acting, legs: [unpriced] })).toBe("ask");
  });

  it("asks when any leg is neither a buy nor a sell", () => {
    const other: GateLeg = { ...buy("1"), direction: null };
    expect(permissionDecision({ specialist: acting, legs: [sell, other] })).toBe("ask");
  });

  it("asks whenever money leaves the account, however it is labelled", () => {
    const send: GateLeg = { ...sell, effect: { ...trade, gets: [] } };
    expect(permissionDecision({ specialist: acting, legs: [send] })).toBe("ask");
  });

  // A pot budgets money, never a lasting power over it, even one reaching only a venue wallet.
  it("asks for a buy that grants anyone a lasting power", () => {
    const lets = "Polymarket trade the cash in your Polymarket wallet";
    const grants = [{ lets, reach: "venue" as const }];
    const setup: GateLeg = { ...buy("1"), effect: { ...trade, grants } };
    expect(permissionDecision({ specialist: acting, legs: [setup] })).toBe("ask");
  });

  it("asks for a trade a tap couldn't vouch for", () => {
    const blind: GateLeg = { ...buy("1"), effect: { ...trade, blind: "can't be simulated" } };
    expect(permissionDecision({ specialist: acting, legs: [blind] })).toBe("ask");
  });
});
