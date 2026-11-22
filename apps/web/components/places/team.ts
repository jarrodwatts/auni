import type { Specialist } from "@/lib/data/views";
import { changePercent, formatUsdcBalance } from "@/lib/money";

import type { ChatPlace, PlaceRoute, SpecialistPlace } from "./use-places";

/**
 * The places as a team: Auni, whose conversation is the latest open chat (the one core's
 * `mainChat` posts news and the brief to), the specialists at work, and History, which holds the
 * retired ones and every older chat.
 */
interface Team {
  /** Auni's conversation; null before the first chat. */
  readonly auni: ChatPlace | null;
  readonly active: readonly SpecialistPlace[];
  readonly retired: readonly SpecialistPlace[];
  /** Every other open chat, newest first. */
  readonly olderChats: readonly ChatPlace[];
}

/** From the places as `usePlaces` lists them: specialists open first, chats newest first. */
export function teamOf(specialists: readonly SpecialistPlace[], chats: readonly ChatPlace[]): Team {
  const [auni = null, ...olderChats] = chats;
  return {
    auni,
    active: specialists.filter(({ specialist }) => specialist.status !== "retired"),
    retired: specialists.filter(({ specialist }) => specialist.status === "retired"),
    olderChats,
  };
}

/** Whether the place open now sits in History, which then opens to show it. */
export function inHistory(team: Team, route: PlaceRoute): boolean {
  if (route.kind === "chat") return team.olderChats.some(({ thread }) => thread.id === route.id);
  if (route.kind === "specialist")
    return team.retired.some(({ specialist }) => specialist.id === route.id);
  return false;
}

/**
 * A specialist's one line under its name. A take with money in it says what it has made, all
 * time and today, once it has had a day to make anything: started today, what it shows is only
 * the cost of getting in, so it says it has just started. Anything else says Auni's read on it
 * (its pulse), or what it holds.
 */
type TeamLine =
  | { readonly kind: "made"; readonly madeBaseUnits: bigint; readonly todayPct: number }
  | { readonly kind: "words"; readonly text: string };

export function teamLine(
  specialist: Pick<
    Specialist,
    "kind" | "pulse" | "value" | "made" | "todayChangeBaseUnits" | "startedAt"
  >,
  now = new Date(),
): TeamLine {
  const value = BigInt(specialist.value.baseUnits);
  if (specialist.kind === "take" && value > 0n) {
    if (new Date(specialist.startedAt).toDateString() === now.toDateString())
      return { kind: "words", text: `Just started, ${formatUsdcBalance(value)} in it` };
    return {
      kind: "made",
      madeBaseUnits: BigInt(specialist.made.baseUnits),
      todayPct: changePercent(BigInt(specialist.todayChangeBaseUnits), value),
    };
  }
  if (specialist.pulse) return { kind: "words", text: specialist.pulse };
  if (value > 0n) return { kind: "words", text: `${formatUsdcBalance(value)} in it` };
  return { kind: "words", text: "No money in it yet" };
}
