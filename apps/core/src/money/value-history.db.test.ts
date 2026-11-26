import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { fills, valueSnapshots } from "../db/schema.ts";
import { insertAction, setOwner, wipe } from "../test/db.ts";
import type { PricePoint } from "./history.ts";
import type { ReadingHolding } from "./portfolio.ts";
import { valueHistory } from "./value-history.ts";

const HOUR = 60 * 60 * 1_000;
/** 4pm in Sydney, 5am in London: every line below is drawn as of then. */
const NOW = Date.parse("2026-10-24T05:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await wipe(valueSnapshots, fills);
});
afterEach(() => vi.useRealTimers());

const NVIDIA = "0xc845b2894dbddd03858fd2d643b4ef725fe0849d";

/** NVIDIA was $200 until an hour ago, and $210 since; nothing else has a history. */
vi.mock(import("./history.ts"), async (original) => ({
  ...(await original()),
  readPaths: vi.fn(async (keys: readonly string[]) => {
    const path: PricePoint[] = [
      { at: NOW - 30 * 24 * HOUR, price: 200 },
      { at: NOW - HOUR, price: 210 },
    ];
    return new Map(keys.map((key) => [key, key === `token:monad:${NVIDIA}` ? path : []]));
  }),
}));

async function snapshot(
  hours: number,
  usdValue: string,
  cashUsd: string | null = null,
  holdings: readonly ReadingHolding[] | null = null,
) {
  await db.insert(valueSnapshots).values({ usdValue, cashUsd, holdings, takenAt: hoursAgo(hours) });
}

/** A buy of `quantity` NVIDIA for `usdValue`, `hours` ago. */
async function buy(hours: number, usdValue: string, quantity = "0.1") {
  const action = await insertAction({ status: "done" });
  await db.insert(fills).values({
    actionId: action.id,
    instrument: NVIDIA,
    chain: "monad",
    side: "buy",
    quantity,
    usdValue,
    createdAt: hoursAgo(hours),
  });
}

/** What a reading keeps of plain cash and of `quantity` NVIDIA worth `usdValue`. */
const held = (cashUsd: string, quantity: string, usdValue: string): ReadingHolding[] => [
  {
    chain: "monad",
    instrument: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    priceId: null,
    quantity: cashUsd,
    decimals: 6,
    usdValue: cashUsd,
    cash: true,
  },
  {
    chain: "monad",
    instrument: NVIDIA,
    priceId: `monad:${NVIDIA}`,
    quantity,
    decimals: 18,
    usdValue,
    cash: false,
  },
];

describe("valueHistory", () => {
  it("starts the line at its first reading with money, keeping a later fall to zero", async () => {
    for (const [hours, usd] of [
      [168, "0.00"],
      [48, "0.00"],
      [27, "49.35"],
      [3, "0.00"],
    ] as const)
      await snapshot(hours, usd, usd, []);

    const history = await valueHistory("All");
    expect(history.points.map((point) => point.usdValue)).toEqual(["49.35", "0.00"]);
    expect(history.startedAt).toBe(hoursAgo(27).toISOString());
  });

  it("keeps money put in and withdrawn within one day, though the day ends at zero", async () => {
    // Funded at 1am and withdrawn by 7am on the 22nd, in London; nothing held since.
    await snapshot(52, "50.00", "50.00", []);
    await snapshot(46, "0.00", "0.00", []);
    await snapshot(20, "0.00", "0.00", []);

    const history = await valueHistory("All");
    expect(history.points.map((point) => point.usdValue)).toEqual(["50.00", "0.00", "0.00"]);
  });

  it("draws every reading on Today, though money came and went between two of its steps", async () => {
    // 00:06, 00:09 and 00:12 in London: $50 put in and taken out again between 00:00 and 00:15.
    const minutes = (past: number) => 5 - past / 60; // hours ago, of minutes past midnight
    await snapshot(minutes(6), "0.00", "0.00", held("0.00", "0", "0.00"));
    await snapshot(minutes(9), "50.00", "50.00", held("50.00", "0", "0.00"));
    await snapshot(minutes(12), "0.00", "0.00", held("0.00", "0", "0.00"));

    const { points } = await valueHistory("Today");
    expect(
      points.map((point) => [point.takenAt.slice(11, 16), point.usdValue]).slice(0, 3),
    ).toEqual([
      ["00:09", "50.00"],
      ["00:12", "0.00"],
      ["00:15", "0.00"],
    ]);
  });

  it("keeps each day's first reading too, so money put in during a day is weighed from then", async () => {
    await snapshot(240, "1.00", "1.00", []);
    await snapshot(30, "1.00", "1.00", []);
    // $1,000 put in just after midnight in London, and worth $1,101 by 4am.
    await snapshot(4.8, "1001.00", "1001.00", []);
    await snapshot(1, "1101.00", "1101.00", []);

    const history = await valueHistory("All");
    expect(history.points.map((point) => point.usdValue)).toEqual([
      "1.00",
      "1.00",
      "1001.00",
      "1101.00",
    ]);
  });

  it("has nothing to draw when the wallet never held money", async () => {
    await snapshot(48, "0.00", "0.00", []);
    await snapshot(1, "0.00", "0.00", []);

    expect(await valueHistory("All")).toEqual({ startedAt: null, points: [] });
  });

  it("keeps the first and last reading of each of the person's own days, however old, beyond a week", async () => {
    await setOwner({ timeZone: "Australia/Sydney" });
    const total = (hours: number, usd: string) => snapshot(hours, usd, usd, []);
    await total(400 * 24, "100.00");
    await total(400 * 24 - 1, "101.00");
    await total(40 * 24, "150.00");
    // 11pm yesterday and 2am today in Sydney: one day in London, two in Sydney.
    await total(17, "160.00");
    await total(14, "170.00");
    await total(1, "180.00");

    const values = async (range: "All" | "1M") =>
      (await valueHistory(range)).points.map((point) => point.usdValue);
    // Today in Sydney began at 2am's $170 and is $180 now.
    expect(await values("All")).toEqual([
      "100.00",
      "101.00",
      "150.00",
      "160.00",
      "170.00",
      "180.00",
    ]);
    expect(await values("1M")).toEqual(["160.00", "170.00", "180.00"]);
  });

  it("leaves out a total read before it kept what it held, so its line, move and start agree", async () => {
    // Read before Auni kept cash, then before it kept holdings, then as it does now.
    await snapshot(20 * 24, "90.00");
    await snapshot(10 * 24, "95.00", "95.00");
    await snapshot(2, "100.20", "100.00", []);

    const history = await valueHistory("1M");
    expect(history.startedAt).toBe(hoursAgo(2).toISOString());
    expect(history.points.map((point) => [point.usdValue, point.madeUsd])).toEqual([
      ["100.20", "0.20"],
    ]);
  });

  // The QA account's morning: $26 of cash, $50 deposited, then $25 of NVIDIA bought.
  it("counts neither a deposit nor a buy as made, only what the holdings did since", async () => {
    await snapshot(5, "26.00", "26.00", held("26.00", "0", "0.00"));
    await snapshot(4, "76.00", "76.00", held("76.00", "0", "0.00"));
    await buy(3.5, "25.00");
    await snapshot(3, "75.88", "51.00", held("51.00", "0.1244", "24.88"));
    await snapshot(2, "76.38", "51.00", held("51.00", "0.1269", "25.38"));

    // From their midnight, five hours ago, every 15 minutes to now; NVIDIA's 5% rise an hour ago adds $1.27.
    const { points } = await valueHistory("Today");
    expect(points).toHaveLength(21);
    expect(
      points.filter((point) => point.takenAt.endsWith(":00:00.000Z")).map((point) => point.madeUsd),
    ).toEqual(["0.00", "0.00", "-0.12", "0.38", "1.65", "1.65"]);
  });

  it("draws the week every hour from a reading, moved by prices since, ending now", async () => {
    await buy(30, "100.00", "0.5");
    await snapshot(30, "120.00", "20.00", held("20.00", "0.5", "100.00"));

    const { points } = await valueHistory("1W");
    expect(points).toHaveLength(31);
    expect(points[0]).toMatchObject({ takenAt: hoursAgo(30).toISOString(), usdValue: "120.00" });
    expect(points.at(-2)).toMatchObject({ usdValue: "125.00", madeUsd: "5.00" });
    expect(points.at(-1)).toMatchObject({
      takenAt: new Date(NOW).toISOString(),
      usdValue: "125.00",
    });
  });
});
