import { CARD_FORMAT } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { assertApprovedSpend, PriceMoved } from "./approved.ts";
import { failureKind, retryRefusal } from "./failure.ts";
import { FeesUnpaid, MayHaveSent, NothingMoved } from "./recipe.ts";
import { Refused, refused } from "./refused.ts";
import { FACE } from "../test/recipe.ts";
import { WouldFail } from "./wallet-effect.ts";

describe("failureKind", () => {
  it("knows a price past what was approved by its refusal, whatever it says", () => {
    expect(failureKind(new PriceMoved("anything"))).toBe("price");
    expect(() => assertApprovedSpend({ amountUsd: "10", details: {} }, 11_000_000n)).toThrow(
      PriceMoved,
    );
  });

  it("lets a move run again whose card's fee purchase went out and hasn't paid: it buys once", () => {
    const kind = failureKind(new FeesUnpaid("Relay has the 15 MON and hasn't paid the ETH yet."));
    expect(kind).toBe("fees");
    const row = {
      status: "failed" as const,
      failureKind: kind,
      tool: "bridge_usdc" as const,
      details: {},
      txs: [{ chain: "monad", hash: "0xbought", setup: true as const, buysFees: "0xorder" }],
      cardFormat: CARD_FORMAT,
      lines: [],
      card: null,
      proposalId: null,
    };
    expect(retryRefusal(row)).toBeNull();
  });

  it("takes an app's word for a refusal it knows, and guesses at one it doesn't", () => {
    const problems = {
      said: () => undefined,
      known: [
        { example: "", when: /too far/u, kind: "rule" as const, say: "The price is too far away." },
        { example: "", when: /far|busy/u, kind: "busy" as const, say: "It is busy." },
      ],
    };
    // The first row that knows it wins, and its kind stands whatever its words would be read as.
    const known = refused("Venue", problems, "price too far, insufficient margin");
    expect(known).toBeInstanceOf(Refused);
    expect(known.message).toBe("The price is too far away.");
    expect(failureKind(known)).toBe("rule");
    expect(failureKind(refused("Venue", problems, "busy now"))).toBe("busy");
    // One no row knows says what the service said, and is read by its words like any message.
    const unknown = refused("Venue", problems, "insufficient margin");
    expect(unknown).not.toBeInstanceOf(Refused);
    expect(unknown.message).toBe("Venue refused: insufficient margin");
    expect(failureKind(unknown)).toBe("funds");
  });

  it("reads money that isn't there", () => {
    for (const said of [
      "Insufficient margin to place order. asset=5",
      "Too little ETH for gas: bridge a few dollars of their cash there as ETH first.",
      "Ledger holds only 0.5 of it.",
      "insufficient funds for gas * price + value",
      "Transfer amount exceeds balance",
      // Found in review: Solana's and a venue's shortfalls fell to unknown, offering a Try again
      // that meets the same shortfall, and no Add money.
      "The wallet needs about 0.002 SOL for Solana's network fees and holds too little, and too little USDC on Solana to buy it (about $0.38).",
      "Needs SOL for network fees",
      'It fails in a simulation ({"InstructionError":[0,{"Custom":1}]}: Transfer: insufficient lamports 5000, need 10000), so nothing was sent.',
      "Insufficient spot balance asset=10000",
    ])
      expect({ said, kind: failureKind(new Error(said)) }).toEqual({ said, kind: "funds" });
  });

  it("reads a venue's rules", () => {
    expect(failureKind(new Error("BTC allows at most 40x leverage."))).toBe("rule");
    expect(failureKind(new Error("Order must have minimum value of $10."))).toBe("rule");
    expect(failureKind(new Error("50% of the position is below BTC's smallest size."))).toBe(
      "rule",
    );
  });

  it("reads a busy venue", () => {
    expect(
      failureKind(
        new Error(
          "The Polymarket wallet already has a transaction in flight; nothing new was sent. Retry once it settles.",
        ),
      ),
    ).toBe("busy");
    expect(
      failureKind(
        new Error("Polymarket's relayer quota for Auni is used up for now; nothing moved."),
      ),
    ).toBe("busy");
    expect(failureKind(new Error("Jupiter answered 429 Too Many Requests"))).toBe("busy");
  });

  it("reads a network blip", () => {
    expect(failureKind(new TypeError("fetch failed"))).toBe("glitch");
    expect(failureKind(new Error("The operation timed out."))).toBe("glitch");
    expect(
      failureKind(
        new Error(
          "Auni couldn't check this in a simulation just now, so nothing was sent. Try again in a moment.",
        ),
      ),
    ).toBe("glitch");
    expect(failureKind(new MayHaveSent({ chain: "solana" }, "The wallet", "socket hang up"))).toBe(
      "glitch",
    );
  });

  it("calls an order its recipe knows nobody filled unfilled", () => {
    expect(failureKind(new NothingMoved("No one filled the order on Monad."))).toBe("unfilled");
  });

  // Live demo: "the pool is paused" read as unknown, so the card's only button was a Try again
  // that would revert the same way.
  it("reads what a simulated revert says, and never offers running the same move again blind", () => {
    const fail = (reason?: string) => failureKind(new WouldFail(1, 1, reason, null));
    expect(fail("the pool is paused")).toBe("rule");
    expect(fail()).toBe("rule");
    expect(fail("Return amount is not enough")).toBe("price");
    expect(fail("ERC20: transfer amount exceeds balance")).toBe("funds");
  });

  // Reviewers' real revert strings: an underscore slippage revert, an allowance or an empty pool
  // read as money short, and the card offered Add money, which could help none of them.
  it("calls a revert money short only when it names the owner's balance", () => {
    const fail = (reason: string) => failureKind(new WouldFail(1, 1, reason, null));
    const kinds = {
      price: [
        "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT",
        "Too little received",
        "Return amount is not enough",
        "Returned amount is too little",
        "amount is too little",
        "Price slippage check",
        "UniswapV2Router: EXCESSIVE_INPUT_AMOUNT",
        "Too much requested",
      ],
      funds: [
        "ERC20: transfer amount exceeds balance",
        "Insufficient balance",
        "insufficient funds for gas * price + value",
        "Dai/insufficient-balance",
      ],
      rule: [
        "ERC20: insufficient allowance",
        "ERC20: transfer amount exceeds allowance",
        "UniswapV2: INSUFFICIENT_LIQUIDITY",
        "Insufficient liquidity",
        "Not enough liquidity",
        "Pausable: paused",
        "the pool is paused",
        "UniswapV2Router: EXPIRED",
        "Transaction too old",
        "",
      ],
    } as const;
    for (const [kind, reasons] of Object.entries(kinds))
      for (const reason of reasons)
        expect({ reason, kind: fail(reason) }).toEqual({ reason, kind });
  });

  it("never reads an allowance or a pool's liquidity as money short, simulated or not", () => {
    for (const said of ["ERC20: insufficient allowance", "Not enough liquidity in the pool"])
      expect(failureKind(new Error(said))).toBe("rule");
  });

  it("calls anything else unknown", () => {
    expect(failureKind("something odd")).toBe("unknown");
  });
});

const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("retryRefusal", () => {
  const failed: Parameters<typeof retryRefusal>[0] = {
    status: "failed",
    failureKind: "glitch",
    tool: "stock_trade",
    details: {},
    txs: [],
    cardFormat: CARD_FORMAT,
    lines: [],
    card: null,
    proposalId: null,
  };

  it("lets a blip, a busy venue, a moved price or anything unknown run again", () => {
    for (const failureKind of ["glitch", "busy", "price", "unknown"] as const)
      expect(retryRefusal({ ...failed, failureKind })).toBeNull();
  });

  // A route can quote inside the card's bounds and still fail its own simulation every time it is
  // built: Try again ran it once on a fresh quote and it failed on its price again.
  it("runs a moved price again once, never a second time it fails on its price", () => {
    const moved = { ...failed, failureKind: "price" as const };
    const before = (kind: "price" | "glitch") => [{ error: "Too little received", kind, at: "" }];
    expect(retryRefusal({ ...moved, previousErrors: [] })).toBeNull();
    expect(retryRefusal({ ...moved, previousErrors: before("glitch") })).toBeNull();
    expect(retryRefusal({ ...moved, previousErrors: before("price") })).toBe("not_retryable");
  });

  it("never runs a step that failed before kinds were recorded, which may have sent", () => {
    expect(retryRefusal({ ...failed, failureKind: null })).toBe("not_retryable");
  });

  it("refuses what running again can't fix", () => {
    for (const failureKind of ["funds", "rule", "sent"] as const)
      expect(retryRefusal({ ...failed, failureKind })).toBe("not_retryable");
    expect(retryRefusal({ ...failed, txs: [{ chain: "base", hash: "0x1" }] })).toBe(
      "not_retryable",
    );
    // An unfilled order's sends stay on its record, which a run again would settle by.
    expect(
      retryRefusal({ ...failed, failureKind: "unfilled", txs: [{ chain: "monad", hash: "0x1" }] }),
    ).toBe("not_retryable");
    expect(retryRefusal({ ...failed, status: "done" })).toBe("not_failed");
  });

  // Its run may grant what that card never showed, such as a first sale's lasting permission.
  it("never runs again a card drawn before cards said all they say now that left a permission out", () => {
    const lets = { label: "Lets", value: "Polymarket's exchanges trade your shares" };
    const old = { ...failed, cardFormat: 1, lines: [lets], card: FACE };
    expect(retryRefusal(old)).toBe("not_retryable");
    expect(retryRefusal({ ...old, proposalId: "plan" })).toBe("not_retryable");
    // Found in review: one allowed on a card that already showed every permission (format 2 on),
    // whatever later formats changed, was allowed having seen it all, so it can still run.
    expect(retryRefusal({ ...old, cardFormat: 2 })).toBeNull();
    expect(retryRefusal({ ...old, cardFormat: 2, proposalId: "plan" })).toBeNull();
    // Found in review: one that leaves nothing, or showed what it leaves, can still finish its plan.
    expect(retryRefusal({ ...old, lines: [] })).toBeNull();
    // Core's plain face drew the line, as far as a figure went (500 characters).
    expect(retryRefusal({ ...old, card: null })).toBeNull();
    expect(
      retryRefusal({
        ...old,
        card: null,
        lines: [{ label: "Lets", value: `${lets.value} and `.repeat(20) }],
      }),
    ).toBe("not_retryable");
    const warned = { ...old, card: { ...FACE, warning: `It lets ${lets.value} afterwards.` } };
    expect(retryRefusal(warned)).toBeNull();
    // Found in review: its card said first what it sends for good, and a warning stops at 500
    // characters, so a permission its own words named late was cut from what the owner saw.
    const late = `${"Read this. ".repeat(40)}It lets ${lets.value} afterwards.`;
    const burns = { ...old, card: { ...FACE, warning: late }, details: { leavesTo: DEAD } };
    expect(retryRefusal({ ...burns, details: {} })).toBeNull();
    expect(retryRefusal(burns)).toBe("not_retryable");
  });

  it("never runs money leaving the person, or anything the owner's proof vouched for, again on a tap", () => {
    expect(retryRefusal({ ...failed, tool: "withdraw_usdc" })).toBe("needs_proof");
    expect(retryRefusal({ ...failed, details: { leavesTo: "0xabc" } })).toBe("needs_proof");
    expect(
      retryRefusal({ ...failed, details: { needsStepUp: "lets 0xabc spend your USDC" } }),
    ).toBe("needs_proof");
  });
});
