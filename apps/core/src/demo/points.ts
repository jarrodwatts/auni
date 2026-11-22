import { TOUR_POINT } from "./tour.ts";

// What the demo's brain writes when core asks for a new chat's starting points
// (conversation/starting-points.ts): the tour, then a point on each of the facts it knows how to
// speak of, as a real brain would write them. It reads the facts core hands any brain, so each
// point cites a fact by its number and wears that fact's picture, and its numbers are the
// demo's own at the moment it is asked.

interface Told {
  readonly number: number;
  readonly from: string;
  readonly fact: string;
}

interface Written {
  readonly statement: string;
  readonly action: string;
  readonly prompt: string;
  readonly facts: readonly number[];
}

/** The facts as core fences them in the prompt (agent/fence.ts), or none. */
function factsIn(prompt: readonly string[]): Told[] {
  const json = /<facts>(.*)<\/facts>/su.exec(prompt.join("\n"))?.[1];
  try {
    return json ? (JSON.parse(json) as Told[]) : [];
  } catch {
    return [];
  }
}

/** A point for each fact this script knows the words for, in the order they are first told. */
const SPOKEN: readonly ((told: Told) => Written | null)[] = [
  // A coin that moved: "BTC, which the owner holds, is down 1.7% in the last day on Hyperliquid".
  ({ number, from, fact }) => {
    const moved = /^(\w+)(, which the owner holds,)? is (up|down) ([\d.]+%)/u.exec(fact);
    if (from !== "prices" || !moved) return null;
    const [, ticker, held, way, percent] = moved;
    return {
      statement: `${ticker} ${way === "down" ? "fell" : "rose"} ${percent} today.`,
      action: "Why?",
      prompt: `${ticker}${held ? ", which I hold," : ""} is ${way} ${percent} today. What's behind the move, and is there a take in it for me?`,
      facts: [number],
    };
  },
  // The Fed market the owner bet on, as Polymarket's trending list has it.
  ({ number, from, fact }) => {
    const chance = /"Will the Fed cut rates in December\?" is at (\d+%)/u.exec(fact)?.[1];
    if (from !== "polymarket" || !chance) return null;
    return {
      statement: `A December cut at ${chance}.`,
      action: "Test it",
      prompt: `Polymarket puts a December Fed cut at ${chance}. Test that for me: is it too high or too low, and what would you do about it?`,
      facts: [number],
    };
  },
  // Their cash: "$9,869.35 of the owner's money is cash, waiting to be used."
  ({ number, from, fact }) => {
    const cash = /^(\$[\d,]+)(?:\.\d+)? of the owner's money is cash/u.exec(fact)?.[1];
    if (from !== "auni" || !cash) return null;
    return {
      statement: `${cash} sits in cash.`,
      action: "Put it to work",
      prompt: `I have ${cash} sitting in cash. What would you do with it?`,
      facts: [number],
    };
  },
];

/** The demo's starting points: the tour first, then one a kind of fact it knows. */
export function demoPoints(prompt: readonly string[]): { readonly points: readonly Written[] } {
  const told = factsIn(prompt);
  return {
    points: [
      TOUR_POINT,
      ...SPOKEN.flatMap((speak) => told.map(speak).find((point) => point !== null) ?? []),
    ],
  };
}
