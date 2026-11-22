import { actionCardSchema, actionPlanCardSchema } from "@auni/shared";
import { describe, expect, it, vi } from "vitest";

import { drawCard, type CardView } from "../channels/draw.ts";
import type { ActionRow } from "../db/schema.ts";
import { stubRecipe } from "../test/recipe.ts";
import { pinnedSol } from "../test/sol.ts";
import { actionCard, moveCards } from "./action-card.ts";
import { costsLabel, costsTogether, effectLines, type Effect } from "./effect.ts";
import {
  feeCoinCash,
  feeCoinsSaid,
  feeCoinTold,
  feeCoinUsd,
  withFeeCoin,
  withoutFeeCoin,
} from "./fee-coin-said.ts";

// Whatever the keys will sign, every card the owner can allow shows first. A card that buys a
// chain's coin for its fees signs a deposit to the pay-in service before its move, so every
// drawing of every kind of card says that purchase, in one quiet line for the whole card: the
// web's single card and plan, a channel's copy of each, and, in full, what the agent is told.
// The words are made in one place (feeCoinsSaid) and this holds every drawing to them.

vi.mock(import("./step-up.ts"), async (original) => ({
  ...(await original()),
  stepUpSays: async () => null,
}));

/** A bridge out of Arbitrum whose card buys the ETH for its fee with 15.25 MON through Relay. */
const preview = withFeeCoin(
  {
    summary: "Move $2 of USDC from Arbitrum to Monad",
    amountUsd: "2",
    effect: {
      gives: [{ text: "$2 of USDC on Arbitrum" }],
      gets: [{ text: "at least $1.94 of USDC", lands: "on Monad" }],
      grants: [],
    },
    details: { arrivesOn: "Monad", getsAtLeast: "1.94" },
  },
  {
    chain: "arbitrum",
    from: "monad",
    token: "native",
    amount: 15_250_000_000_000_000_000n,
    usd: 0.25,
    by: "Relay",
  },
);

const row = (fields: Partial<ActionRow> = {}): ActionRow =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    threadId: null,
    specialistId: null,
    proposalId: null,
    status: "awaiting_permission",
    phase: null,
    tool: "bridge_usdc",
    venue: "across",
    summary: preview.summary,
    amountUsd: "2",
    lines: effectLines(preview.effect),
    details: preview.details ?? {},
    run: {},
    card: null,
    input: { from_chain: "arbitrum", to_chain: "monad", amount: "2" },
    txs: [],
    error: null,
    failureKind: null,
    attempts: 1,
    previousErrors: [],
    createdAt: new Date(0),
    startedAt: null,
    updatedAt: new Date(0),
    ...fields,
  }) as ActionRow;

/** The same bridge from Polygon, buying POL with $0.25 of Monad's USDC. */
const second = row({
  id: "22222222-2222-4222-8222-222222222222",
  summary: "Move $3 of USDC from Polygon to Monad",
  amountUsd: "3",
  input: { from_chain: "polygon", to_chain: "monad", amount: "3" },
  details: withFeeCoin(preview, {
    chain: "polygon",
    from: "monad",
    token: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    amount: 250_000n,
    usd: 0.25,
    by: "Relay",
  }).details!,
});
const buy = row({
  id: "33333333-3333-4333-8333-333333333333",
  tool: "stock_trade",
  venue: "kuru",
  summary: "Buy $3 of NVIDIA",
  amountUsd: "3",
  lines: [{ label: "You give", value: "$3 of USDC" }],
  details: {},
  input: { side: "buy", usd: "3" },
});

/** The card's one line of what it spends on coin for fees (see feeCoinsSaid). */
const fees = (dollars: string, coins: string, by = "Relay") =>
  `Also buys about ${dollars} of ${coins} for network fees, most of which stays in your wallet. Bought through ${by}.`;
const ONE = fees("$0.25", "ETH");
const BOTH = fees("$0.50", "ETH and POL");

const view = (legs: ActionRow[]): CardView => ({
  legs,
  inTheApp: false,
  decidedIn: null,
  link: "https://auni.example/app",
});
const inPlan = (legs: ActionRow[]) =>
  legs.map((leg) => ({ ...leg, proposalId: "44444444-4444-4444-8444-444444444444" }));

describe("what a card says of the coin it buys for fees", () => {
  it("is one line for a whole card, in dollars, or nothing for a card that buys none", () => {
    expect(feeCoinsSaid([row()])).toBe(ONE);
    expect(feeCoinsSaid([row(), second, buy])).toBe(BOTH);
    expect(actionPlanCardSchema.shape.buysFirst.safeParse(BOTH).success).toBe(true);
    expect(feeCoinsSaid([buy])).toBeNull();
    expect(feeCoinTold([buy])).toBeNull();
  });

  it("is on the web's single card, whatever fine print the move's own face carries", async () => {
    const plain = await actionCard(row(), stubRecipe());
    expect(plain.card.buysFirst).toBe(ONE);
    // It is no cost: what the fees don't use of the coin stays the owner's.
    expect(plain.lines.map(({ label }) => label)).toEqual(["You give", "You get"]);
    // A face with fine print of its own at full length loses none of the purchase's words.
    const face = { ...plain.card, finePrint: "x".repeat(500), buysFirst: undefined };
    const wordy = await actionCard(row({ card: face }), stubRecipe());
    expect(wordy.card.buysFirst).toBe(ONE);
    expect(actionCardSchema.safeParse(wordy).success).toBe(true);
    expect((await actionCard(buy, stubRecipe())).card.buysFirst).toBeUndefined();
  });

  it("is never under a plan's rows, each of which reads as its move alone", () => {
    const [bridge, other] = moveCards(inPlan([row(), second]));
    expect(bridge).toEqual({
      actionReference: row().id,
      name: "Move $2 from Arbitrum to Monad",
      from: "your Arbitrum wallet",
      lands: "monad",
      status: "awaiting_permission",
    });
    expect(other).not.toHaveProperty("buys");
    expect(actionPlanCardSchema.shape.moves.element.safeParse(bridge).success).toBe(true);
  });

  it("is the same one line on a channel's copy of a single card and of a plan, while it waits", () => {
    const single = drawCard(view([row()]), "grant").text.split("\n");
    expect(single.some((line) => line.startsWith("Costs"))).toBe(false);
    expect(single).toContain(ONE);
    const plan = drawCard(view(inPlan([row(), second, buy])), "grant").text.split("\n");
    expect(plan).toEqual([
      "**A plan of 3 moves, one tap for all of them**",
      "1. Move $2 of USDC from Arbitrum to Monad: Waiting for you",
      "2. Move $3 of USDC from Polygon to Monad: Waiting for you",
      "3. Buy $3 of NVIDIA: Waiting for you",
      BOTH,
    ]);
    // Once it is allowed, the copy says where each move stands and no longer what Allow signs.
    const allowed = inPlan([row(), buy]).map((leg) => ({
      ...leg,
      status: "running" as const,
      phase: "queued" as const,
    }));
    expect(drawCard(view(allowed), null).text).not.toContain("Relay");
  });

  it("is said the same way of SOL, whichever way it is bought", async () => {
    // A buy on Solana whose card buys SOL with a dollar of Monad's USDC (sol-top-up.ts).
    const sol = row({
      tool: "solana_swap",
      venue: "solana-swap",
      summary: "Buy $2 of JUP",
      lines: [{ label: "You give", value: "$2 of USDC" }],
      details: pinnedSol("1000000"),
      input: { token: "JUP", side: "buy", amountUsd: 2 },
    });
    expect((await actionCard(sol, stubRecipe())).card.buysFirst).toBe(fees("$1", "SOL"));
    expect(drawCard(view(inPlan([sol, buy])), "grant").text.split("\n")).toContain(
      fees("$1", "SOL"),
    );
    // Swapped on Solana itself, it is bought with the USDC there, and rests on nobody.
    const swapped = row({ ...sol, details: pinnedSol("380000", "swap") });
    expect(drawCard(view([swapped]), "grant").text).toContain(fees("$0.38", "SOL", "Jupiter"));
  });

  it("is told the agent, with that it is no cost", () => {
    expect(feeCoinTold([row(), second, buy])).toBe(
      `The card also says: "${BOTH}" That purchase is not among its costs: what the fees don't use stays in the wallet as that coin, for later moves, so never call it lost to fees.`,
    );
  });
});

// A card that buys a chain's coin for its fees showed the whole purchase under Costs ("$1.25 ($1
// SOL for fees, $0.25 price move)"), though the fees use cents of it and the rest stays in the
// wallet. Costs are what the move spends; the purchase is said apart, and still counts as cash
// leaving where a card's cash is checked and in a specialist's pot.
describe("what a card's costs count of the coins it buys for fees", () => {
  const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
  const trade = (costs: Effect["costs"]) => ({
    summary: "Buy about $5 of Palantir on Solana",
    amountUsd: "5",
    effect: {
      gives: [{ text: "$5 of USDC" }],
      gets: [{ text: "about 0.03 PLTRx" }],
      grants: [] as const,
      costs,
    },
    details: { chain: "solana" },
  });
  const sol = (usd: number) => ({
    chain: "solana" as const,
    from: "monad" as const,
    token: MONAD_USDC,
    amount: BigInt(Math.round(usd * 1e6)),
    usd,
    by: "Relay",
  });
  const mon = (usd: number) => ({
    chain: "base" as const,
    from: "monad" as const,
    token: "native",
    amount: 15_151_500_000_000_000_000n,
    usd,
    by: "Relay",
  });

  it("leaves a card's costs as the move's own, in its lines and its sums, and back again without it", () => {
    const made = trade([{ label: "price move", usd: 0.03 }]);
    const card = withFeeCoin(made, sol(1));
    expect(card.effect).toBe(made.effect);
    expect(effectLines(card.effect)).toContainEqual({ label: "Costs", value: "$0.03 price move" });
    expect(costsLabel(costsTogether([card.effect]))).toBe("$0.03 price move");
    // A move that costs nothing of its own has no Costs line at all, however much it buys.
    const free = withFeeCoin(trade([]), sol(1));
    expect(effectLines(free.effect).map(({ label }) => label)).toEqual(["You give", "You get"]);
    expect(withoutFeeCoin(card)).toEqual(made);
  });

  it("counts the purchase as cash spent, to the cent, where funding and a pot weigh it", () => {
    // Pinned to the cent, as the card says it and execute is held to it.
    const card = withFeeCoin(trade([]), sol(0.125));
    expect(card.details).toMatchObject({ feeCoinUsd: "0.13", feeCoinAmount: "125000" });
    expect(feeCoinCash(card.details!)).toEqual({ from: "monad", usd: "0.13" });
    expect(feeCoinUsd(card.details!)).toBe("0.13");
    expect(feeCoinsSaid([{ details: card.details! }])).toBe(
      "Also buys about $0.13 of SOL for network fees, most of which stays in your wallet. Bought through Relay.",
    );
  });

  it("sums a plan's costs without the two coins it buys, and says those apart, to the cent", () => {
    // Two moves each paying a network fee, a trade's price move, and two coins bought: ETH for
    // Base with MON, which is no cash, and SOL with Monad's USDC, which is.
    const toMonad = withFeeCoin(
      { ...trade([{ label: "network fee", usd: 0.1 }]), summary: "Move $2 from Base to Monad" },
      mon(0.1),
    );
    const toSolana = withFeeCoin(
      { ...trade([{ label: "network fee", usd: 0.2 }]), summary: "Move $5 from Monad to Solana" },
      sol(0.2),
    );
    const buy = trade([{ label: "price move", usd: 0.005 }]);
    const legs = [toMonad, toSolana, buy];
    expect(costsLabel(costsTogether(legs.map(({ effect }) => effect)))).toBe(
      "$0.31 ($0.30 network fee, under $0.01 price move)",
    );
    expect(feeCoinsSaid(legs.map(({ details }) => ({ details: details! })))).toBe(
      "Also buys about $0.30 of ETH and SOL for network fees, most of which stays in your wallet. Bought through Relay.",
    );
    // The cash the card is checked for counts the SOL's USDC beside its moves; the MON is no cash.
    expect(legs.map(({ details }) => feeCoinCash(details!))).toEqual([
      null,
      { from: "monad", usd: "0.20" },
      null,
    ]);
    // A specialist's pot counts both purchases, beside the moves they serve.
    expect(legs.map(({ details }) => feeCoinUsd(details!))).toEqual(["0.10", "0.20", null]);
  });
});
