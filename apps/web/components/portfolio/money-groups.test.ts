import type { ActivityItemWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { usdc } from "@/lib/data/usdc";
import type { Holding } from "@/lib/data/views";

import { chartMoves, moneyView, recentOf, splitDust, takeTimeline } from "./money-groups";

const holding = (id: string, dollars: number): Holding => ({
  id,
  name: id,
  detail: "",
  logoUrl: null,
  value: usdc(BigInt(dollars * 1_000_000)),
  todayChangeBaseUnits: null,
});

const item = (fields: Partial<ActivityItemWire>) =>
  ({ id: "x", kind: "move", amount: null, threadId: null, ...fields }) as ActivityItemWire;

describe("splitDust", () => {
  it("folds what is under 1% of all the money into the crumbs", () => {
    const { shown, dust } = splitDust(
      [holding("sol", 1201), holding("eth", 190), holding("pol", 3)],
      BigInt(19_000 * 1_000_000),
    );
    expect(shown.map(({ id }) => id)).toEqual(["sol", "eth"]);
    expect(dust.map(({ id }) => id)).toEqual(["pol"]);
  });

  it("never folds real money on a large account: a crumb is also under $25", () => {
    const { shown, dust } = splitDust(
      [holding("eth", 950), holding("pol", 3)],
      BigInt(100_000 * 1_000_000),
    );
    expect(shown.map(({ id }) => id)).toEqual(["eth"]);
    expect(dust.map(({ id }) => id)).toEqual(["pol"]);
  });

  it("keeps everything when there is no money to measure against", () => {
    expect(splitDust([holding("pol", 3)], 0n).dust).toEqual([]);
  });
});

describe("recentOf", () => {
  const buy = item({ id: "buy", category: "trade" });
  const sent = item({ id: "sent", category: "transfer" });
  const arrived = item({ id: "arrived", kind: "arrival", category: "transfer" });
  // A stop-loss that lost money is a trade, though its amount reads as money out.
  const stopped = item({
    id: "stopped",
    kind: "outside",
    category: "trade",
    amount: { usd: "76.51", direction: "out", tone: "loss" },
  });
  const all = [buy, sent, arrived, stopped];

  it("splits every item by what it is, and All keeps them all", () => {
    expect(recentOf(all, "all")).toEqual(all);
    expect(recentOf(all, "trades").map(({ id }) => id)).toEqual(["buy", "stopped"]);
    expect(recentOf(all, "transfers").map(({ id }) => id)).toEqual(["sent", "arrived"]);
  });
});

describe("takeTimeline", () => {
  it("is the take's latest moves, oldest first, and how many came before", () => {
    const items = ["6", "5", "x", "4", "3", "2", "1"].map((id) =>
      item({ id, threadId: (id === "x" ? "other" : "take") as ActivityItemWire["threadId"] }),
    );
    const { moves, earlier } = takeTimeline(items, "take");
    expect(moves.map(({ id }) => id)).toEqual(["3", "4", "5", "6"]);
    expect(earlier).toBe(2);
  });
});

describe("moneyView", () => {
  it("shows the first-use prompt only with no money and no past", () => {
    expect(moneyView(true, [])).toBe("first-use");
    expect(moneyView(false, [])).toBe("overview");
  });

  it("keeps the receipts in reach after the owner withdraws it all", () => {
    expect(moneyView(true, [item({ kind: "move" })])).toBe("overview");
  });

  it("waits to tell while the moves are still loading, and shows the page when they can't be read", () => {
    expect(moneyView(true, undefined)).toBe("waiting");
    expect(moneyView(true, null)).toBe("overview");
  });
});

describe("chartMoves", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();
  const moved = (id: string, day: number, category: "trade" | "transfer", usd: string) =>
    item({
      id,
      at: at(day),
      category,
      amount: { usd, direction: category === "transfer" ? "in" : null, tone: "neutral" },
    });

  it("marks every move in the period, oldest first, and writes the largest money in and out", () => {
    const items = [
      moved("bought", 26, "trade", "9000.00"),
      moved("small-in", 25, "transfer", "20.00"),
      moved("out", 24, "transfer", "400.00"),
      moved("deposit", 23, "transfer", "5000.00"),
      moved("before", 10, "transfer", "9999.00"),
    ];
    const moves = chartMoves(items, Date.parse(at(20)));
    expect(moves.map(({ item, noted }) => [item.id, noted])).toEqual([
      ["deposit", true],
      ["out", true],
      ["small-in", false],
      // However large, a trade is the line's own story, so it is a bead without a note.
      ["bought", false],
    ]);
  });
});
