import { describe, expect, it } from "vitest";

import { apps } from "../apps/registry.ts";
import { executionKeys, executionLane } from "./actions.ts";
import { APPROVED_SALE_OF } from "./approved.ts";
import { toolRecipe } from "./recipes/index.ts";

/** A recorded move, as far as its lane goes: its tool's recipe names it. */
const row = (id: string, tool: string, details: Record<string, string> = {}) => {
  expect(toolRecipe(tool), tool).toBeDefined();
  return { id, tool, details };
};

describe("executionLane", () => {
  it("runs every move of an app that says so one after another, in the app's own lane", () => {
    // Hyperliquid, so an order places at its own leverage; Polymarket, as its relayer takes them.
    const oneAtATime = apps().filter((app) => app.oneAtATime);
    expect(oneAtATime.map(({ about }) => about.id)).toEqual(
      expect.arrayContaining(["hyperliquid", "polymarket"]),
    );
    for (const { about, moves } of oneAtATime)
      for (const { tool } of moves ?? [])
        expect(executionLane(row(`${tool}-1`, tool)), tool).toBe(about.id);
  });

  it("runs the moves of an app that doesn't say so each in a lane of its own", () => {
    expect(executionLane(row("a", "aave_supply"))).toBe("a");
  });

  it("runs Monad stock trades one after another, and the rest in a lane of their own", () => {
    const stock = "stock_trade";
    expect(executionLane(row("a", stock, { chain: "monad" }))).toBe("monad-stocks");
    expect(executionLane(row("b", stock, { chain: "solana" }))).toBe("b");
    expect(executionLane(row("c", "move_holding"))).toBe("ledger");
    expect(executionLane(row("d", "bridge_usdc"))).toBe("d");
  });
});

describe("executionKeys", () => {
  const action = (
    id: string,
    tool: string,
    input: Record<string, unknown>,
    details: Record<string, string>,
    venue = "jupiter",
  ) => ({ id, venue, tool, input, details, amountUsd: "10" });
  const sells = (holding: string) => ({ [APPROVED_SALE_OF]: holding });

  it("runs moves of one holding one after another, whichever lane each runs in", () => {
    // A Solana stock sale runs in its own venue lane, so only this keeps two of them apart.
    const sale = (id: string) =>
      action(id, "stock_trade", { side: "sell", stock: "NVDA" }, sells("solana:nvda"));
    expect(executionKeys(sale("a")).holding).toBe(executionKeys(sale("b")).holding);
    expect(executionKeys(sale("a"))).toEqual({ lane: "a", holding: "holding:solana:nvda" });
  });

  it("keys a buy by what it's about, so it waits on a sale of the same holding", () => {
    const buy = action(
      "c",
      "stock_trade",
      { side: "buy", stock: "NVDA" },
      { chain: "solana", mint: "nvda" },
    );
    expect(executionKeys(buy).holding).toBe("holding:solana:nvda");
  });

  it("queues a swap of one holding for another on both, so it waits on a sale of either", () => {
    const swap = action(
      "e",
      "evm_swap",
      { chain: "base", sellToken: "0xaaaa", buyToken: "0xbbbb" },
      { chain: "base", mint: "0xbbbb", ...sells("base:0xaaaa") },
      "evm-swap",
    );
    const saleOfB = action(
      "f",
      "evm_swap",
      { chain: "base", sellToken: "0xbbbb" },
      sells("base:0xbbbb"),
      "evm-swap",
    );
    expect(executionKeys(swap)).toMatchObject({
      lane: "holding:base:0xbbbb",
      holding: "holding:base:0xaaaa",
    });
    expect(executionKeys(saleOfB).holding).toBe(executionKeys(swap).lane);
  });

  it("queues a raw swap on what its simulation showed it sending and getting", () => {
    const raw = action(
      "g",
      "send_evm_transaction",
      { chain: "base" },
      { sendsUpTo: "0xaaaa:100", getsAbout: "0xbbbb:200" },
      "evm",
    );
    expect(executionKeys(raw)).toMatchObject({
      holding: "holding:base:0xaaaa",
      lane: "holding:base:0xbbbb",
    });
  });

  it("gives a move of no holding its own two lanes, which never share a name", () => {
    const bridge = action(
      "d",
      "bridge_usdc",
      { from_chain: "base", to_chain: "monad" },
      {},
      "across",
    );
    expect(executionKeys(bridge)).toEqual({ lane: "d", holding: "holding:d" });
  });
});
