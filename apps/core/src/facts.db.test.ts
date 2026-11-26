import { beforeEach, describe, expect, it, vi } from "vitest";

import { STARTING_POINTS } from "@auni/shared";

import { db } from "./db/client.ts";
import { fills } from "./db/schema.ts";
import { insertAction, insertThread, setOwner, wipe } from "./test/db.ts";
import { readFacts } from "./facts.ts";
import type { Holding, Portfolio } from "./money/portfolio.ts";

// Auni's own facts from a portfolio read as given here, and active threads in the database.

const { CASH_LOGO, NVIDIA_LOGO } = vi.hoisted(() => ({
  CASH_LOGO: "/brand/tokens/usdc.svg",
  NVIDIA_LOGO: "https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png",
}));
const read = vi.hoisted(() => ({
  portfolio: null as Portfolio | null,
  wallet: true,
  seen: [] as unknown[],
}));
vi.mock("./money/wallets.ts", () => ({ hasWallet: async () => read.wallet }));
vi.mock("./conversation/context.ts", () => ({ promptPortfolio: async () => read.portfolio }));
vi.mock("./money/holdings.ts", () => ({
  holdingFaces: async (holdings: readonly Holding[]) =>
    holdings.map((holding) =>
      holding.symbol === "NVDAx"
        ? { name: "NVIDIA", logoUrl: NVIDIA_LOGO }
        : { name: holding.symbol, logoUrl: null },
    ),
  LOGOS: { usdc: CASH_LOGO },
  // The wallet pays Monad's fees itself, in MON.
  paysFees: async (holding: Holding) => holding.instrument === "native",
}));
vi.mock("./money/day-moves.ts", () => ({
  dayMoves: async (holdings: readonly Holding[]) =>
    holdings.map((holding) => (holding.symbol === "NVDAx" ? "-4.10" : null)),
}));
vi.mock("./apps/registry.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  factSources: () => [
    {
      about: { id: "prices", name: "Prices" },
      facts: async (seen: unknown) => {
        read.seen.push(seen);
        return [];
      },
    },
  ],
}));

function holding(symbol: string, usdValue: string, cash = false): Holding {
  return {
    chain: "monad",
    instrument: symbol,
    venue: "wallet",
    symbol,
    quantity: "1",
    decimals: 6,
    usdValue,
    cash,
    priceId: null,
  };
}

function portfolio(holdings: readonly Holding[]): Portfolio {
  const cash = holdings.filter((each) => each.cash);
  const assets = holdings.filter((each) => !each.cash);
  const sum = (some: readonly Holding[]) =>
    some.reduce((total, each) => total + Number(each.usdValue), 0).toFixed(2);
  return {
    observedAt: new Date().toISOString(),
    totalUsd: sum(holdings),
    unavailable: [],
    looking: [],
    holdings,
    assets: { usdValue: sum(assets), holdings: assets },
    cash: { usdValue: sum(cash), holdings: cash },
    onTheWay: { usdValue: "0", moves: [] },
  };
}

beforeEach(async () => {
  await wipe();
  await setOwner();
  read.portfolio = null;
  read.wallet = true;
  read.seen = [];
});

describe("readFacts", () => {
  it("always tells the owner's money, even with nothing in it", async () => {
    read.portfolio = portfolio([]);
    const facts = await readFacts();
    expect(facts).toEqual([
      {
        text: "The owner hasn't added any money yet: their wallet is empty.",
        source: { app: "auni", label: "Your money", link: "/app" },
        image: null,
        starts: [
          expect.objectContaining({ statement: "Your wallet is empty.", action: "Get started" }),
          expect.objectContaining({ statement: "New to Auni?", action: "Start here" }),
          expect.objectContaining({ statement: "Have a belief?", action: "Make it real" }),
          expect.objectContaining({ statement: "Markets today.", action: "What's moving?" }),
        ],
      },
    ]);
    expect(read.seen).toEqual([{ holdings: [] }]);
  });

  it("never calls a wallet empty before there is one, as first run makes it with the first take", async () => {
    read.wallet = false;
    read.portfolio = portfolio([]);
    const [money] = await readFacts();
    expect(money!.text).toBe(
      "The owner has no wallet yet: Auni makes one with their first take, or with the first move if it couldn't then.",
    );
    expect(money!.starts.map(({ statement }) => statement)).not.toContain("Your wallet is empty.");
    expect(money!.starts).toHaveLength(STARTING_POINTS);
  });

  it("says so when their money can't be read", async () => {
    const [money] = await readFacts();
    expect(money!.text).toBe("The owner's money couldn't be read just now.");
    // Every new chat shows STARTING_POINTS, and their money alone gives as many.
    expect(money!.starts).toHaveLength(STARTING_POINTS);
  });

  it("tells their money, their cash, active threads and largest holdings with their marks, and apps what they hold", async () => {
    read.portfolio = portfolio([
      holding("USDC", "310.50", true),
      holding("NVDAx", "620.40"),
      holding("ETH", "80.00"),
      holding("DUST", "0.00"),
      // The coin every fee there is paid in: no holding to ask whether to keep or sell.
      { ...holding("MON", "0.01"), instrument: "native" },
    ]);
    const thread = await insertThread({
      title: "AI chips",
      actMode: "within_limits",
      budgetUsd: "200.00",
      notes: "NVIDIA held up after earnings.",
    });
    await insertThread({
      title: "Archived",
      actMode: "within_limits",
      budgetUsd: "100.00",
      archivedAt: new Date(),
    });
    await insertThread({ title: "Quiet chat" });

    const facts = await readFacts();
    expect(facts.map(({ text }) => text)).toEqual([
      "The owner has $1,010.91 in all, $310.50 of it cash.",
      "$310.50 of the owner's money is cash, waiting to be used.",
      'The owner\'s thread "AI chips" is running Auto up to $200. Notes: NVIDIA held up after earnings.',
      "The owner holds $620.40 of NVIDIA, down $4.10 today.",
      "The owner holds $80 of ETH.",
    ]);
    expect(facts[2]!.source).toEqual({
      app: "auni",
      label: "AI chips",
      link: `/app/chat/${thread.id}`,
    });
    expect(facts[0]!.starts.map(({ statement, action }) => `${statement} ${action}`)).toEqual([
      "You have $1,010.91. Look it over",
      "Have a belief? Make it real",
      "Markets today. What's moving?",
      "New to Auni? Start here",
    ]);
    expect(facts[1]!.starts.map(({ statement, action }) => `${statement} ${action}`)).toEqual([
      "$310.50 is in cash. Put it to work",
    ]);
    // Cash wears cash's own mark, as the portfolio shows it; a holding its logo.
    expect(facts.map(({ image }) => image)).toEqual([null, CASH_LOGO, null, NVIDIA_LOGO, null]);
    expect(facts[3]!.starts[0]!.statement).toBe("NVIDIA is down $4.10.");
    expect(read.seen).toEqual([
      {
        holdings: [
          { symbol: "NVDAx", name: "NVIDIA", usdValue: "620.40", image: NVIDIA_LOGO },
          { symbol: "ETH", name: "ETH", usdValue: "80.00", image: null },
        ],
      },
    ]);
  });

  it("counts as cash only what Money does: savings a take bought are already at work", async () => {
    const aave = { ...holding("aUSDC", "4000.00", true), venue: "aave" };
    read.portfolio = portfolio([holding("USDC", "310.50", true), aave]);
    const earning = await insertThread({ title: "Keep my idle cash earning" });
    const action = await insertAction({ status: "done", threadId: earning.id });
    await db.insert(fills).values({
      actionId: action.id,
      threadId: earning.id,
      chain: aave.chain,
      instrument: aave.instrument,
      side: "buy",
      quantity: aave.quantity,
      usdValue: "4000.00",
    });

    const [whole, cash] = await readFacts();
    expect(whole!.text).toBe("The owner has $4,310.50 in all, $310.50 of it cash.");
    expect(cash!.starts.map(({ statement }) => statement)).toEqual(["$310.50 is in cash."]);
  });
});
