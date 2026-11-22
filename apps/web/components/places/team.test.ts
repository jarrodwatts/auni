import { describe, expect, it } from "vitest";

import type { Specialist, Thread } from "@/lib/data/views";
import { usdc } from "@/lib/data/usdc";

import { inHistory, teamLine, teamOf } from "./team";
import type { ChatPlace, SpecialistPlace } from "./use-places";

const place = (id: string, status: Specialist["status"]) =>
  ({ specialist: { id, status } }) as SpecialistPlace;
const chat = (id: string) => ({ thread: { id } as Thread }) as ChatPlace;

describe("teamOf", () => {
  const team = teamOf(
    [place("gold", "active"), place("cash", "active"), place("robots", "retired")],
    [chat("latest"), chat("older"), chat("oldest")],
  );

  it("makes the latest open chat Auni's and puts the rest in History", () => {
    expect(team.auni?.thread.id).toBe("latest");
    expect(team.olderChats.map(({ thread }) => thread.id)).toEqual(["older", "oldest"]);
  });

  it("keeps the specialists at work in order and retired ones in History", () => {
    expect(team.active.map(({ specialist }) => specialist.id)).toEqual(["gold", "cash"]);
    expect(team.retired.map(({ specialist }) => specialist.id)).toEqual(["robots"]);
  });

  it("has no Auni chat before the first one", () => {
    expect(teamOf([], []).auni).toBeNull();
  });

  it("opens History for the place open in it, and only for that", () => {
    expect(inHistory(team, { kind: "chat", id: "older" as Thread["id"] })).toBe(true);
    expect(inHistory(team, { kind: "chat", id: "latest" as Thread["id"] })).toBe(false);
    expect(inHistory(team, { kind: "specialist", id: "robots" as Specialist["id"] })).toBe(true);
    expect(inHistory(team, { kind: "specialist", id: "gold" as Specialist["id"] })).toBe(false);
    expect(inHistory(team, { kind: "portfolio" })).toBe(false);
  });
});

describe("teamLine", () => {
  const money = (dollars: number) => usdc(BigInt(Math.round(dollars * 1_000_000)));
  const specialist = (over: Partial<Parameters<typeof teamLine>[0]>) => ({
    kind: "take" as const,
    pulse: null,
    value: money(0),
    made: money(0),
    todayChangeBaseUnits: "0",
    startedAt: "2026-11-10T09:00:00.000Z",
    ...over,
  });

  it("says what a take with money has made, all time and today", () => {
    expect(
      teamLine(
        specialist({
          value: money(102),
          made: money(12),
          todayChangeBaseUnits: (2_000_000).toString(),
          pulse: "Holding up",
        }),
      ),
    ).toEqual({ kind: "made", madeBaseUnits: 12_000_000n, todayPct: 2 });
  });

  it("says a take started today has just started, not what getting in cost", () => {
    const started = new Date(2026, 10, 17, 9, 30);
    const take = specialist({
      value: money(49.93),
      made: money(-0.07),
      startedAt: started.toISOString(),
    });
    expect(teamLine(take, new Date(2026, 10, 17, 9, 31))).toEqual({
      kind: "words",
      text: "Just started, $49.93 in it",
    });
    expect(teamLine(take, new Date(2026, 10, 18, 9, 31))).toMatchObject({ kind: "made" });
  });

  it("gives a role its pulse, or what it holds", () => {
    expect(
      teamLine(specialist({ kind: "role", value: money(500), pulse: "Earning 4.1%" })),
    ).toEqual({ kind: "words", text: "Earning 4.1%" });
    expect(teamLine(specialist({ kind: "role", value: money(500) }))).toEqual({
      kind: "words",
      text: "$500 in it",
    });
  });

  it("says when nothing is in it yet, unless Auni has a read on it", () => {
    expect(teamLine(specialist({}))).toEqual({ kind: "words", text: "No money in it yet" });
    expect(teamLine(specialist({ pulse: "Researching" }))).toEqual({
      kind: "words",
      text: "Researching",
    });
  });
});
