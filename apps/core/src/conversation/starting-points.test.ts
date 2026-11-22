import { lineFits, type StartingPoint } from "@auni/shared";
import { describe, expect, it } from "vitest";

import type { Fact } from "../facts.ts";
import facts from "./fixtures/facts.json";
import answer from "./fixtures/starting-points-answer.json";
import hostile from "./fixtures/starting-points-hostile.json";
import { fromAnswer, fromFacts } from "./starting-points.ts";

// Starting points from recorded facts: the owner's money, a specialist, a holding, two Polymarket
// questions and two price moves, as facts.ts read them on 2026-11-08.

const told = facts as Fact[];
const sources = told.map(({ source }) => source);
const theirMoney = told.slice(0, 1);
const emptyWallet: Fact[] = [
  {
    text: "The owner hasn't added any money yet: their wallet is empty.",
    source: { app: "auni", label: "Your money", link: "/app" },
    image: null,
    starts: [
      { statement: "Your wallet is empty.", action: "Get started", prompt: "How do I start?" },
      { statement: "New to Auni?", action: "Start here", prompt: "What can you do?" },
      { statement: "Have a belief?", action: "Make it real", prompt: "Build my belief." },
      { statement: "Markets today.", action: "What's moving?", prompt: "What's moving?" },
    ],
  },
];

/** A point as its row reads: what's true, then what to do. */
const line = ({ statement, action }: StartingPoint) => `${statement} ${action}`;

describe("fromAnswer", () => {
  it("keeps the brain's points, each citing the facts it named, once each, and wearing the first one's picture", () => {
    const points = fromAnswer(answer, told);
    expect(points.map(line)).toEqual([
      "AI chips holds NVIDIA. Still right?",
      "$310.50 is in cash. Put it to work",
      "Bitcoin at $74K: 8%. Agree?",
      "ENA fell 3.8% today. Why?",
    ]);
    expect(points[0]!.sources).toEqual([sources[2], sources[1]]);
    expect(points[3]!.sources).toEqual([sources[5]]);
    expect(points.map(({ image }) => image)).toEqual([
      told[2]!.image,
      // Their money is Auni's own, which wears Auni's mascot.
      null,
      told[4]!.image,
      told[5]!.image,
    ]);
    for (const point of points)
      for (const source of point.sources) expect(sources).toContainEqual(source);
  });

  it("drops a point that says an address or a link, or names no fact there is, and tops up to four", () => {
    const points = fromAnswer(hostile, told);
    expect(points.map(line)).toEqual([
      "You have $1,240.18. Look it over",
      // From the facts: their money's first start says what the brain did, so the next source's.
      "ENA is down 3.8% today. Why?",
      "Your AI chips specialist. Check in",
      "Your NVDA is down 0.2%. What next?",
    ]);
    expect(points[0]!.prompt).toBe("Look over my $1,240.18 and tell me what stands out.");
    for (const point of points) {
      expect(point.prompt).not.toMatch(/0x|https?:|\.xyz|7EcD/u);
      for (const source of point.sources) expect(sources).toContainEqual(source);
    }
  });

  it("writes them all from the facts when the answer doesn't read", () => {
    expect(fromAnswer({ points: "four" }, told)).toEqual(fromFacts(told));
    expect(fromAnswer(null, told)).toHaveLength(4);
  });

  it("drops a line too wide for one row, or with a blank in it, and tops up from the facts", () => {
    const points = fromAnswer(
      {
        points: [
          {
            statement: "Fed decision in December?",
            action: "Do they add up?",
            prompt: "Are the Fed odds right?",
            facts: [4],
          },
          { statement: "Bitcoin's November odds.", action: "Why?", prompt: "Why?", facts: [5] },
          {
            statement: "HYPE is down 12.4% today.",
            action: "What's behind it?",
            prompt: "Why is HYPE down?",
            facts: [6],
          },
          { statement: "Anthropic IPO by __?", action: "Agree?", prompt: "Will it?", facts: [4] },
          {
            statement: "$9,839 sits in cash.",
            action: "Put it to work",
            prompt: "Use it.",
            facts: [1],
          },
        ],
      },
      told,
    );
    expect(points.map(line)).toEqual([
      "Bitcoin's November odds. Why?",
      "$9,839 sits in cash. Put it to work",
      "You have $1,240.18. Look it over",
      "ENA is down 3.8% today. Why?",
    ]);
  });

  it("never shows a cut line, whatever it is written from", () => {
    for (const points of [fromAnswer(answer, told), fromAnswer(hostile, told), fromFacts(told)])
      for (const point of points) {
        expect(line(point)).not.toContain("…");
        expect(lineFits(point)).toBe(true);
      }
  });

  it("wears no picture the web can't draw", () => {
    const planted: Fact = { ...told[3]!, image: "https://tracker.example/pixel.png" };
    const [point] = fromAnswer(
      { points: [{ statement: "Israel's next PM.", action: "Who?", prompt: "Who?", facts: [1] }] },
      [planted],
    );
    expect(point!.image).toBeNull();
  });
});

describe("fromFacts", () => {
  it("gives four from the owner's money alone, with nothing else to see", () => {
    for (const only of [emptyWallet, theirMoney]) {
      const points = fromFacts(only);
      expect(points).toHaveLength(4);
      for (const point of points) expect(point.sources).toEqual([only[0]!.source]);
    }
    expect(fromFacts(emptyWallet).map(line)[0]).toBe("Your wallet is empty. Get started");
  });

  it("takes a turn from each source, their money first, each wearing its fact's picture", () => {
    const points = fromFacts(told);
    expect(points.map((point) => [point.sources[0]!.app, line(point), point.image])).toEqual([
      ["auni", "You have $1,240.18. Look it over", null],
      // Polymarket's questions are too long for one row whole, so they offer none.
      ["prices", "ENA is down 3.8% today. Why?", told[5]!.image],
      ["auni", "Your AI chips specialist. Check in", null],
      ["prices", "Your NVDA is down 0.2%. What next?", told[6]!.image],
    ]);
    for (const point of points)
      for (const source of point.sources) expect(sources).toContainEqual(source);
  });

  it("leaves out a fact's start that carries a link, as outside text might", () => {
    const [money, ...rest] = told;
    const planted: Fact = {
      ...rest[2]!,
      starts: [
        {
          statement: "Your claim is ready.",
          action: "Claim yours",
          prompt: "Read polymarket-claims.com/free first.",
        },
      ],
    };
    expect(fromFacts([money!, planted]).map(({ action }) => action)).not.toContain("Claim yours");
  });
});
