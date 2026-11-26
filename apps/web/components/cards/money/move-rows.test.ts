import { AMOUNT, type ActionPlanLeg, type ActionRecordId } from "@auni/shared";
import { describe, expect, it } from "vitest";

import type { Leg, Move } from "./plan-legs";
import { failedStep } from "./failed-step";
import {
  actionRows,
  amountNote,
  headerLine,
  moveRows,
  overall,
  planLeg,
  shownRows,
  spotlit,
  type MoveRow,
} from "./move-rows";

const id = (value: string) => value as ActionRecordId;
/** What a bet's face says before its market's name, in place of buying. */
const BET = { now: "Betting on", done: "Bet on", failed: "Didn't bet on" };
const usdc = (dollars: number) => ({
  baseUnits: String(dollars * 1_000_000),
  currency: { code: "USDC", decimals: 6 },
});

function leg(name: string, changes: Partial<Leg> = {}): Leg {
  return {
    actionReference: id(name),
    name,
    why: `Why ${name}`,
    venue: "jupiter",
    logoUrl: `https://example.com/${name}.png`,
    logoName: name,
    amount: usdc(50),
    flow: "in",
    status: "awaiting_permission",
    error: null,
    failureKind: null,
    retryable: false,
    started: false,
    held: false,
    ...changes,
  };
}

function move(name: string, changes: Partial<Move> = {}): Move {
  return {
    actionReference: id(name),
    name,
    from: "your Monad wallet",
    lands: "polygon",
    status: "awaiting_permission",
    error: null,
    failureKind: null,
    retryable: false,
    started: false,
    held: false,
    ...changes,
  };
}

const read = (rows: readonly MoveRow[]) => rows.map((row) => `${row.status}: ${row.label}`);
/** What a row that didn't go through says, before any quote. */
const reason = (row: MoveRow) => row.failure && failedStep(row.failure, null, true).reason;

describe("moveRows", () => {
  const bridge = move("Move $30 to Polygon");
  const nvidia = leg("NVIDIA");
  // A bet says so in its move's own verbs, which core sends with the pick (see CardFace.pick).
  const bet = leg("Nvidia tops $6T by June: Yes", {
    venue: "polymarket",
    amount: usdc(30),
    verbs: BET,
  });

  it("lists the moves that get the money ready first, then the picks, each by name before the tap", () => {
    expect(read(moveRows([bridge], [nvidia, bet]))).toEqual([
      "waiting: Move $30 to Polygon",
      "waiting: NVIDIA",
      "waiting: Nvidia tops $6T by June",
    ]);
  });

  it("says what each is doing while it runs, and what it did once done", () => {
    const rows = moveRows(
      [{ ...bridge, status: "done" }],
      [
        { ...nvidia, status: "done" },
        { ...bet, status: "running", started: true },
      ],
    );
    expect(read(rows)).toEqual([
      "done: Moved $30 to Polygon",
      "done: Bought NVIDIA",
      "now: Betting on Nvidia tops $6T by June",
    ]);
    expect(read(moveRows([{ ...bridge, status: "running", started: true }], []))).toEqual([
      "now: Moving $30 to Polygon",
    ]);
  });

  it("keeps an allowed pick waiting until core starts it", () => {
    expect(read(moveRows([], [{ ...nvidia, status: "running", started: false }]))).toEqual([
      "waiting: NVIDIA",
    ]);
  });

  it("has every row of a stage that runs together happening at once", () => {
    const rows = moveRows(
      [
        { ...bridge, status: "running", started: true },
        move("Take $20 out of savings", {
          lands: "base",
          from: "your savings",
          status: "running",
          started: true,
        }),
      ],
      [{ ...nvidia, status: "running" }],
    );
    expect(read(rows)).toEqual([
      "now: Moving $30 to Polygon",
      "now: Taking $20 out of savings",
      "waiting: NVIDIA",
    ]);
  });

  it("says a sell, a perp it opens and one it closes in their own words", () => {
    const perp = { side: "long", leverage: 3, size: "$60", liquidationMove: 0.32 } as const;
    const rows = moveRows(
      [],
      [
        leg("Tesla", { flow: "back", status: "done" }),
        leg("Microsoft", { perp, status: "running", started: true }),
        leg("Bitcoin", {
          flow: "back",
          perp: { ...perp, closes: { all: true, pnlUsd: -4.63 } },
          status: "failed",
          started: true,
        }),
      ],
    );
    expect(read(rows)).toEqual([
      "done: Sold Tesla",
      "now: Opening Microsoft",
      "failed: Didn't close Bitcoin",
    ]);
    expect(rows[1]!.tags).toEqual([{ text: "3x long", tone: "plain" }]);
    // A close names the bet it lets go of in its line, not as a tag.
    expect(rows[2]!.tags).toEqual([]);
  });

  it("says what a pick costs only when that's more than a normal trade's, and only before the tap", () => {
    const rows = moveRows(
      [],
      [
        leg("Oklo", { cost: "$14.97" }),
        leg("Nvidia"),
        leg("Johnson & Johnson", { cost: "$0.62", status: "done" }),
      ],
    );
    expect(rows.map((row) => row.tags)).toEqual([
      [{ text: "Costs $14.97", tone: "plain" }],
      [],
      [],
    ]);
  });

  it("shows the money on the right, a sale's with a plus, and none once a row didn't go through", () => {
    const rows = moveRows(
      [],
      [
        nvidia,
        leg("Tesla", { flow: "back", amount: usdc(12) }),
        leg("AMD", { status: "failed", started: true }),
      ],
    );
    expect(rows.map((row) => row.meta)).toEqual(["$50", "+$12", null]);
  });

  it("marks a move with where its cash lands, and a pick with its own logo", () => {
    const [cash, venue, pick] = moveRows(
      [bridge, move("Move $8 to Hyperliquid", { lands: "hyperliquid" })],
      [nvidia],
    );
    expect(cash!.logo).toMatchObject({ kind: "image", src: "/brand/tokens/usdc.svg" });
    expect(cash!.badge).toBe("/brand/tokens/pol.png");
    expect(venue!.badge).toBe("/logos/hyperliquid.svg");
    expect(pick!.logo).toMatchObject({ kind: "image", src: "https://example.com/NVIDIA.png" });
    expect(pick!.badge).toBeNull();
    // A move that readies no cash of its own (a token sold home) shows the cash alone.
    const unlanded: Move = {
      actionReference: id("unlanded"),
      name: "Move $5 to Solana",
      status: "done",
      error: null,
      failureKind: null,
      retryable: false,
      started: true,
      held: false,
    };
    expect(moveRows([unlanded], [])[0]!.badge).toBeNull();
  });

  it("says what a mixed card's pick does only until its words say it", () => {
    const sell = leg("Tesla", { flow: "back", verb: "Sell" });
    expect(moveRows([], [sell])[0]!.tags).toEqual([{ text: "Sell", tone: "back" }]);
    expect(moveRows([], [{ ...sell, status: "running", started: true }])[0]!.tags).toEqual([]);
  });

  it("says why a pick didn't go through when core said it plainly, and where the money is otherwise", () => {
    const rows = moveRows(
      [],
      [
        leg("AMD", { status: "failed", started: true, error: "AMD moved past your price." }),
        leg("TSMC", { status: "failed", started: true, error: "{ code: 500 }" }),
      ],
    );
    expect(rows.map((row) => [row.label, reason(row), row.line])).toEqual([
      ["Didn't buy AMD", "AMD moved past your price. Your money stayed where it was.", null],
      ["Didn't buy TSMC", "It didn't go through. Your money stayed where it was.", null],
    ]);
  });

  // Core's words for a send whose wallet couldn't pay the network fee (assertOwnGas, core's gas.ts).
  it("names the coin a pick was short of for its network fee, rather than money", () => {
    const short =
      "Nothing was sent: too little MON for the network fee. The wallet holds 0.01 MON on " +
      "Monad, and this needs about 0.01833 MON on hand.";
    const failed = { status: "failed", started: true, failureKind: "funds", error: short } as const;
    const [row] = moveRows([], [leg("NVIDIA", failed)]);
    expect(reason(row!)).toBe(`${short} Your money stayed where it was.`);
  });

  // Core judges that by what the step recorded, such as a send of the move itself.
  it("offers Try again only on a step core says can run again", () => {
    const failed = { status: "failed", started: true, failureKind: "glitch" } as const;
    const rows = moveRows([], [leg("AMD", { ...failed, retryable: true }), leg("TSMC", failed)]);
    expect(rows.map((row) => row.failure && failedStep(row.failure, null, true).actions)).toEqual([
      ["retry", "ask"],
      ["ask"],
    ]);
  });

  // Core stops only what a failed move's money was for; each stopped step says so, and the
  // move that stopped it says why and offers Try again for both.
  it("crosses off what a move that didn't go through stopped, and says it was skipped", () => {
    const stopped = {
      status: "failed",
      failureKind: "stopped",
      error: "Skipped: the money for it couldn't be moved first, so nothing was spent.",
    } as const;
    const rows = moveRows(
      [{ ...bridge, status: "failed", started: true, error: "The bridge didn't answer." }],
      [
        { ...nvidia, ...stopped },
        { ...bet, status: "done", started: true },
      ],
    );
    expect(read(rows)).toEqual([
      "failed: Didn't move $30 to Polygon",
      "failed: Didn't buy NVIDIA",
      "done: Bet on Nvidia tops $6T by June",
    ]);
    expect(rows.map(reason)).toEqual([
      "The bridge didn't answer. Your money is still in your Monad wallet.",
      "Skipped, since the money for it couldn't be moved first. Nothing was spent.",
      null,
    ]);
    expect(rows[1]!.failure && failedStep(rows[1]!.failure, null, false).actions).toEqual([]);
  });

  // Taking it out of Hyperliquid failed, so the money never reached Arbitrum for the bridge on.
  it("never says a skipped move's money is where it would have left from", () => {
    const rows = moveRows(
      [
        move("Take $7 out of Hyperliquid", {
          from: "Hyperliquid",
          lands: "arbitrum",
          status: "failed",
          started: true,
          error: "Hyperliquid didn't answer.",
        }),
        move("Move $6 to Monad", {
          from: "your Arbitrum wallet",
          lands: "monad",
          status: "failed",
          failureKind: "stopped",
        }),
      ],
      [],
    );
    expect(rows.map(reason)).toEqual([
      "Hyperliquid didn't answer. Your money is still in Hyperliquid.",
      "Skipped, since the money for it couldn't be moved first. Nothing was spent.",
    ]);
  });

  it("settles with what went through ticked and what didn't crossed", () => {
    const rows = moveRows(
      [{ ...bridge, status: "done" }],
      [
        { ...nvidia, status: "done" },
        { ...bet, status: "failed", started: true },
      ],
    );
    expect(read(rows)).toEqual([
      "done: Moved $30 to Polygon",
      "done: Bought NVIDIA",
      "failed: Didn't bet on Nvidia tops $6T by June",
    ]);
  });

  it("says a move it can't put in tense by its name throughout", () => {
    const rows = moveRows([move("Bring $5 home", { status: "done" })], []);
    expect(read(rows)).toEqual(["done: Bring $5 home"]);
  });
});

describe("planLeg", () => {
  const base = {
    actionReference: id("nvda"),
    tool: "stock_trade",
    venue: "jupiter",
    logoUrl: null,
    logoName: "NVDA",
    summary: "Buy about $50 of Nvidia on Solana",
    line: "Tokenized stock",
    lines: [],
    details: {},
    amount: usdc(50),
    flow: "in",
    status: "awaiting_permission",
  } as const satisfies Partial<ActionPlanLeg>;

  it("says a move in its own card's words as it runs and once done", () => {
    const plan = planLeg({
      ...base,
      card: {
        title: `Buy NVDA for ${AMOUNT}`,
        action: `Buy ${AMOUNT}`,
        working: "Buying NVDA",
        context: "Tokenized stock",
        figures: [{ label: "You pay", value: AMOUNT }],
        finePrint: null,
        receipt: { title: "Bought NVDA", detail: "About 0.27 shares", amount: "spent" },
      },
    });
    const rows = (status: Leg["status"], started = true) =>
      moveRows(
        [],
        [
          {
            ...plan,
            status,
            started,
            held: false,
            error: null,
            failureKind: null,
            retryable: false,
          },
        ],
      );
    expect(read(rows("awaiting_permission"))).toEqual(["waiting: Buy NVDA for $50"]);
    expect(read(rows("running"))).toEqual(["now: Buying NVDA"]);
    expect(read(rows("done"))).toEqual(["done: Bought NVDA"]);
    expect(read(rows("failed"))).toEqual(["failed: Didn't buy NVDA for $50"]);
  });

  it("reads a prediction as its market with the side tagged, betting on it as it runs", () => {
    const plan = planLeg({
      ...base,
      tool: "polymarket_order",
      venue: "polymarket",
      card: {
        title: `Buy Yes for ${AMOUNT}`,
        action: `Buy ${AMOUNT}`,
        working: "Buying Yes",
        context: "Rate cut in December",
        figures: [{ label: "You pay", value: AMOUNT }],
        finePrint: null,
        pick: { name: "Rate cut in December", tag: "Yes", verbs: BET },
        receipt: { title: "Bought Yes", detail: "Rate cut in December", amount: "spent" },
      },
    });
    const [row] = moveRows(
      [],
      [
        {
          ...plan,
          status: "running",
          started: true,
          held: false,
          error: null,
          failureKind: null,
          retryable: false,
        },
      ],
    );
    expect(row!.label).toBe("Betting on Rate cut in December");
    expect(row!.tags).toEqual([{ text: "Yes", tone: "plain" }]);
  });
});

describe("actionRows", () => {
  const words = { working: "Buying Nvidia", done: "Bought Nvidia" };

  it("is allowing, with the rest to come, while the tap is on its way", () => {
    const rows = actionRows(
      { tool: "stock_trade", details: {} },
      { status: "awaiting_permission", phase: null, txs: [] },
      words,
    );
    expect(read(rows)).toEqual(["now: Allowing", "waiting: Buying Nvidia", "waiting: Confirming"]);
    expect(rows.every((row) => row.logo === null && row.meta === null)).toBe(true);
  });

  it("ticks sent once the move's own transaction has a hash, not its approval", () => {
    const approving = actionRows(
      { tool: "evm_swap", details: {} },
      { status: "running", phase: "sending", txs: [{ chain: "monad", hash: "0xa", setup: true }] },
      words,
    );
    expect(read(approving)).toEqual(["done: Allowed", "now: Buying Nvidia", "waiting: Confirming"]);
    const sent = actionRows(
      { tool: "evm_swap", details: {} },
      {
        status: "running",
        phase: "sending",
        txs: [
          { chain: "monad", hash: "0xa", setup: true },
          { chain: "monad", hash: "0xb" },
        ],
      },
      words,
    );
    expect(read(sent)).toEqual([
      "done: Allowed",
      "done: Sent on Monad",
      "now: Confirming on Monad",
    ]);
  });

  it("says a bridge is on its way to where it arrives, even when it swaps on the way", () => {
    const rows = actionRows(
      { tool: "bridge_usdc", details: { arrivesOn: "Ethereum" } },
      { status: "running", phase: "sending", txs: [{ chain: "monad", hash: "0xb" }] },
      { working: "Moving $11", done: "Moved $11 from Monad to Ethereum" },
    );
    expect(read(rows)).toEqual([
      "done: Allowed",
      "done: Sent on Monad",
      "now: On its way to Ethereum",
    ]);
  });

  it("ticks a crossing as arrived once done, since it runs until it lands", () => {
    const rows = actionRows(
      { tool: "hyperliquid_deposit", details: { arrivesOn: "Hyperliquid" } },
      { status: "done", phase: null, txs: [{ chain: "arbitrum", hash: "0xc" }] },
      { working: "Moving $20", done: "Moved $20 to Hyperliquid" },
    );
    expect(read(rows)).toEqual([
      "done: Allowed",
      "done: Sent on Arbitrum",
      "done: Arrived on Hyperliquid",
    ]);
  });

  it("ticks a Hyperliquid withdrawal sent once core says where it lands, as it has no hash", () => {
    const words = { working: "Withdrawing $20", done: "Withdrew $20" };
    const sending = actionRows(
      { tool: "hyperliquid_withdraw", details: { arrivesOn: "Arbitrum" } },
      { status: "running", phase: "sending", txs: [] },
      words,
    );
    expect(read(sending)).toEqual([
      "done: Allowed",
      "now: Withdrawing $20",
      "waiting: On its way to Arbitrum",
    ]);
    const out = actionRows(
      { tool: "hyperliquid_withdraw", details: { arrivesOn: "Arbitrum" } },
      { status: "running", phase: "landing", txs: [] },
      words,
    );
    expect(read(out)).toEqual(["done: Allowed", "done: Sent", "now: On its way to Arbitrum"]);
  });

  it("keeps an order working until it fills, since it leaves no transaction to tick", () => {
    const working = actionRows(
      { tool: "hyperliquid_order", details: {} },
      { status: "running", phase: "sending", txs: [] },
      { working: "Opening your long", done: "Opened long on BTC" },
    );
    expect(read(working)).toEqual(["done: Allowed", "now: Opening your long"]);
    const filled = actionRows(
      { tool: "hyperliquid_order", details: {} },
      { status: "done", phase: null, txs: [] },
      { working: "Opening your long", done: "Opened long on BTC" },
    );
    expect(read(filled)).toEqual(["done: Allowed", "done: Opened long on BTC"]);
  });

  it("ticks every step in past words once it lands", () => {
    const rows = actionRows(
      { tool: "solana_swap", details: {} },
      { status: "done", phase: null, txs: [{ chain: "solana", hash: "5x" }] },
      words,
    );
    expect(read(rows)).toEqual(["done: Allowed", "done: Sent on Solana", "done: Bought Nvidia"]);
  });
});

describe("spotlit", () => {
  const row = (key: string, status: MoveRow["status"]) => ({ key, status }) as unknown as MoveRow;

  it("rests on the first row happening now, though a stage runs several at once", () => {
    expect(spotlit([row("a", "done"), row("b", "now"), row("c", "now")])).toBe("b");
  });

  it("waits by the first row that didn't go through once nothing is happening", () => {
    expect(spotlit([row("a", "done"), row("b", "failed"), row("c", "waiting")])).toBe("b");
    expect(spotlit([row("a", "failed"), row("b", "now")])).toBe("b");
  });

  it("goes when nothing is happening and nothing failed", () => {
    expect(spotlit([row("a", "done"), row("b", "waiting")])).toBeNull();
  });
});

describe("shownRows", () => {
  const rows = (...statuses: MoveRow["status"][]) =>
    statuses.map((status, index) => ({ key: String(index), status }) as MoveRow);

  it("shows every row while they fit, one more than the cut included", () => {
    expect(shownRows(rows("done", "done", "done", "done", "done", "done"))).toBe(6);
  });

  it("cuts to five past that, so the card stays a glance", () => {
    expect(shownRows(rows("done", "done", "done", "done", "done", "now", "waiting"))).toBe(5);
  });

  it("never hides a row that didn't go through, since its reason and retry are there", () => {
    expect(shownRows(rows("done", "done", "done", "done", "done", "done", "failed"))).toBe(7);
  });
});

describe("overall", () => {
  const rows = (...statuses: MoveRow["status"][]) =>
    statuses.map((status) => ({ status }) as MoveRow);

  it("reads the rows behind N more as one mark", () => {
    expect(overall(rows("done", "now", "waiting"))).toBe("now");
    expect(overall(rows("done", "done"))).toBe("done");
    expect(overall(rows("done", "waiting"))).toBe("waiting");
  });
});

describe("a held row", () => {
  const why = "Auni sent this and didn't get a receipt back.";
  const held = { status: "running", started: true, held: true, error: why } as const;

  it("stops, named as it was asked, and waits on the person with why", () => {
    const [row] = moveRows([], [leg("NVIDIA", held)]);
    expect(row).toMatchObject({
      label: "NVIDIA",
      status: "failed",
      failure: { held: true, said: why, retryable: false },
    });
    const [cash] = moveRows([move("Move $30 to Polygon", held)], []);
    expect(cash).toMatchObject({ label: "Move $30 to Polygon", failure: { held: true } });
  });

  it("is counted on its card as status unknown, never as gone through or not", () => {
    const after = { done: 0, flow: "in", own: "2 picks", phase: "after" } as const;
    expect(headerLine({ ...after, held: 1, total: 1 }).text).toBe("Status unknown");
    expect(headerLine({ ...after, held: 1, total: 2 }).text).toBe("1 with status unknown");
    expect(headerLine({ ...after, done: 1, held: 1, total: 2 }).text).toBe(
      "1 of 2 went through, 1 with status unknown",
    );
  });
});

describe("headerLine", () => {
  const card = { done: 0, flow: "in", own: "5 picks", phase: "before", total: 5 } as const;

  it("says the card's own line before the tap", () => {
    expect(headerLine(card)).toEqual({ text: "5 picks", working: false });
  });

  it("says what the money is doing while it moves", () => {
    expect(headerLine({ ...card, phase: "running" })).toEqual({
      text: "Putting your money in",
      working: true,
    });
    expect(headerLine({ ...card, flow: "back", phase: "running" })).toEqual({
      text: "Moving your money",
      working: true,
    });
  });

  it("never says money is moving while a card that moves none runs", () => {
    expect(headerLine({ ...card, flow: null, phase: "running" })).toEqual({
      text: "Working on it",
      working: true,
    });
  });

  it("says how much went through once it's over", () => {
    const after = { ...card, phase: "after" } as const;
    expect(headerLine({ ...after, done: 5 }).text).toBe("All 5 went through");
    expect(headerLine({ ...after, done: 4 }).text).toBe("4 of 5 went through");
    expect(headerLine({ ...after, done: 0 }).text).toBe("None went through");
    expect(headerLine({ ...after, done: 1, total: 1 }).text).toBe("It went through");
    // Live in the demo, 2026-11-16: "All 2 went through".
    expect(headerLine({ ...after, done: 2, total: 2 }).text).toBe("Both went through");
  });
});

describe("amountNote", () => {
  it("says what the money does before, while and after it moves", () => {
    expect(amountNote("before", "in", false)).toBe("to put in");
    expect(amountNote("running", "in", false)).toBe("on its way");
    expect(amountNote("after", "in", false)).toBe("put in");
    expect(amountNote("before", "back", false)).toBe("coming back");
    expect(amountNote("after", "back", false)).toBe("back to cash");
  });

  it("says nothing was placed when getting the money ready didn't go through", () => {
    expect(amountNote("after", "in", true)).toBe("not placed");
  });
});
