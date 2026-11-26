import { CARD_FORMAT } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { assertApprovedSpend, PriceMoved } from "./approved.ts";
import { failureKind, retryRefusal } from "./failure.ts";
import { FeesUnpaid, MayHaveSent, NothingMoved } from "./recipe.ts";
import { Refused, refused } from "./refused.ts";
import { FACE } from "../test/recipe.ts";

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
    ])
      expect(failureKind(new Error(said))).toBe("funds");
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

  // Found in review: a card from before format 3 named a spender by its first and last four
  // digits, which another address can share, and pinned only those words.
  it("never runs again a format-2 card that vouched for a power over the wallet by its words alone", () => {
    const lets = { label: "Lets", value: "0xAbCd…1234 spend your USDC" };
    const shortly = { needsStepUp: `lets ${lets.value}` };
    const two = { ...failed, cardFormat: 2, lines: [lets], card: FACE, details: shortly };
    expect(retryRefusal(two)).toBe("not_retryable");
    // An order or a venue's permission a format-2 card showed among its terms isn't one.
    const order = { label: "Lets", value: "Hyperliquid close the whole position at $90" };
    expect(retryRefusal({ ...two, lines: [order], details: {} })).toBeNull();
    // One pinned exactly runs again, with the owner's proof as any power over the wallet takes.
    const exactly = { ...shortly, grantsExactly: "spend:0x1:0x2::" };
    expect(retryRefusal({ ...two, details: exactly })).toBe("needs_proof");
    expect(retryRefusal({ ...two, cardFormat: CARD_FORMAT, details: exactly })).toBe("needs_proof");
    // Found in review: one pinned before each permission kept which token account or NFT it
    // reaches, whatever its card's format, vouched for less than a send is now held to.
    const fewer = { ...shortly, grantsExactly: "spend:0x1:0x2" };
    expect(retryRefusal({ ...two, cardFormat: CARD_FORMAT, details: fewer })).toBe("not_retryable");
    // Found in review: a format-1 card pinned no more, whether core drew its line whole or its
    // own words warned of it, so it is never tried again either.
    const one = { ...two, cardFormat: 1 };
    expect(retryRefusal({ ...one, card: null })).toBe("not_retryable");
    const warned = { ...FACE, warning: `It lets ${lets.value} afterwards.` };
    expect(retryRefusal({ ...one, card: warned })).toBe("not_retryable");
    expect(retryRefusal({ ...one, card: warned, details: exactly })).toBe("needs_proof");
  });

  // Its run may grant what that card never showed, such as a first sale's lasting permission.
  it("never runs again a card drawn before cards said all they say now that left a permission out", () => {
    const lets = { label: "Lets", value: "Polymarket's exchanges trade your shares" };
    const old = { ...failed, cardFormat: 1, lines: [lets], card: FACE };
    expect(retryRefusal(old)).toBe("not_retryable");
    expect(retryRefusal({ ...old, proposalId: "plan" })).toBe("not_retryable");
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
      retryRefusal({
        ...failed,
        details: { needsStepUp: "lets 0xabc spend your USDC", grantsExactly: "spend:0x1:0xabc::" },
      }),
    ).toBe("needs_proof");
  });
});
