import type { ActivityItemWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { usdc } from "@/lib/data/usdc";
import type { Holding } from "@/lib/data/views";

import { recentOf, splitDust, takeTimeline } from "./money-groups";

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

  it("keeps everything when there is no money to measure against", () => {
    expect(splitDust([holding("pol", 3)], 0n).dust).toEqual([]);
  });
});

describe("recentOf", () => {
  const buy = item({ id: "buy", amount: { usd: "250", direction: null, tone: "neutral" } });
  const sent = item({ id: "sent", amount: { usd: "40", direction: "out", tone: "neutral" } });
  const arrived = item({ id: "arrived", kind: "arrival" });
  const closed = item({ id: "closed", kind: "outside" });
  const all = [buy, sent, arrived, closed];

  it("splits every item into a trade or money in and out, and All keeps them all", () => {
    expect(recentOf(all, "all")).toEqual(all);
    expect(recentOf(all, "trades").map(({ id }) => id)).toEqual(["buy", "closed"]);
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
