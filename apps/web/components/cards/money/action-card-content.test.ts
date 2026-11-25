import { AMOUNT, filledUsd, type CardFace } from "@auni/shared";
import { describe, expect, it } from "vitest";

import {
  actionCardContent,
  cardMark,
  figureWidth,
  planPermissions,
  withFilled,
} from "./action-card-content";

const usdc = (baseUnits: string) => ({ baseUnits, currency: { code: "USDC", decimals: 6 } });

// What a card says is written by its move, in core (money/card-face.ts and each app's
// card.ts, with their tests). The web fills in the card's amount and picks its mark.

/** A stock sale's face, as core sends it. */
const sale: CardFace = {
  title: "Sell NVDA",
  action: `Sell ${AMOUNT}`,
  working: "Selling NVDA",
  context: "Tokenized stock",
  figures: [
    { label: "You sell", value: "0.004683 NVDAx" },
    { label: "You get, at least", value: "0.9787 USDC" },
  ],
  finePrint: null,
  price: "$212.44",
  receipt: { title: "Sold NVDA", detail: "Tokenized stock", amount: "back" },
};
const card = {
  card: sale,
  venue: "jupiter" as const,
  logoUrl: null,
  logoName: null,
  amount: usdc("990000"),
};

describe("actionCardContent", () => {
  it("draws the face core sent, with the card's own amount wherever the face says it", () => {
    const content = actionCardContent(card);
    expect(content).toMatchObject({
      title: "Sell NVDA",
      action: "Sell $0.99",
      context: "Tokenized stock",
      figures: sale.figures,
      receipt: { title: "Sold NVDA", amount: "$0.99 back" },
    });
    expect(content.mark).toEqual({ kind: "integration", integration: "jupiter" });
  });

  it("says what a filled sale brought back, not what its card priced, as the agent's report does", () => {
    const content = actionCardContent(withFilled(card, "0.98"));
    expect(content.receipt).toMatchObject({ title: "Sold NVDA", amount: "$0.98 back" });
    // Before it fills there is nothing returned, and the card keeps its price.
    expect(withFilled(card, undefined)).toBe(card);
  });

  // The card's amount is the most a buy may cost, which every receipt showed for what it spent
  // until its run began to keep the fills' own figure (2026-11-13).
  it("reads what a filled move really moved from its run: what a sale brought back, or a buy spent", () => {
    expect(filledUsd({ returnedUsd: "0.98" })).toBe("0.98");
    expect(filledUsd({ spentUsd: "1.00" })).toBe("1.00");
    expect(filledUsd({})).toBeNull();
    const ceiling = { ...card, amount: usdc("1050000") };
    expect(withFilled(ceiling, filledUsd({ spentUsd: "1.00" })).amount).toEqual(usdc("1000000"));
    expect(withFilled(ceiling, filledUsd({}))).toBe(ceiling);
  });

  it("wears the picture core sent for what the move is about", () => {
    const content = actionCardContent({ ...card, logoUrl: "https://example.com/nvda.png" });
    expect(content.mark).toEqual({
      kind: "image",
      src: "https://example.com/nvda.png",
      fallback: { kind: "integration", integration: "jupiter" },
    });
  });

  it("wears the logo a face brings of its own, whatever the move trades", () => {
    const logo = {
      src: "https://t1.gstatic.com/faviconV2?url=https://aave.com",
      inset: true,
      name: "Aave",
    };
    const content = actionCardContent({
      ...card,
      card: { ...sale, logo },
      logoUrl: "https://example.com/usdc.png",
      logoName: "USDC",
    });
    expect(content.mark).toEqual({
      kind: "image",
      src: logo.src,
      inset: true,
      fallback: { kind: "initials", name: "Aave" },
    });
    // The logo is the mark, not a word of the card.
    expect(content).not.toHaveProperty("logo");
  });

  it("wears the initial of an app with no logo, not the initials of the token it trades", () => {
    // A stake gets sMON and its unstake gets MON: both cards are Kintsu's, and wear its "K".
    const kintsu = { card: { ...sale, logo: { src: null, inset: false, name: "Kintsu" } } };
    const stake = { ...card, ...kintsu, logoName: "sMON" };
    const unstake = { ...card, ...kintsu, logoName: "MON" };
    expect(actionCardContent(stake).mark).toEqual({ kind: "initials", name: "Kintsu" });
    expect(actionCardContent(unstake).mark).toEqual(actionCardContent(stake).mark);
    // A plan's leg is marked by the same rule.
    expect(cardMark(stake)).toEqual({ kind: "initials", name: "Kintsu" });
  });
});

describe("cardMark", () => {
  it("draws core's logo, falling back to the initials of what it shows", () => {
    expect(
      cardMark({ logoUrl: "/brand/tokens/usdc.svg", logoName: "USDC", venue: "auni" }),
    ).toEqual({
      kind: "image",
      src: "/brand/tokens/usdc.svg",
      fallback: { kind: "initials", name: "USDC" },
    });
  });

  it("draws a token with no logo anywhere by its own initials, never the move's sentence", () => {
    expect(cardMark({ logoUrl: null, logoName: "PRL", venue: "auni" })).toEqual({
      kind: "initials",
      name: "PRL",
    });
  });

  it("draws cash going to or from a venue with its venue's mark", () => {
    expect(cardMark({ logoUrl: null, logoName: null, venue: "aave" })).toEqual({
      kind: "integration",
      integration: "aave",
    });
  });
});

describe("figureWidth", () => {
  it("gives a long value, and a whole address, more of the row, so none is ever cut", () => {
    expect(figureWidth({ value: "$50.00" }, false)).toBe("column");
    expect(figureWidth({ value: "under $0.01 network fee" }, false)).toBe("wide");
    expect(figureWidth({ value: "2.5 USDC ($2.50), 1 MON ($0.02)" }, false)).toBe("row");
    // What it is worth, said beside it, counts too.
    expect(figureWidth({ value: "18.97 WPRL", note: "$25.00" }, false)).toBe("wide");
    expect(figureWidth({ value: "0x97c5e2b14D8A6F3c0E9b7A51D2c4F86e3a1D0b91" }, true)).toBe("row");
  });
});

describe("planPermissions", () => {
  const leg = (summary: string, value?: string) => ({
    summary,
    lines: [
      { label: "You give", value: "$50 of USDC" },
      ...(value ? [{ label: "Lets", value }] : []),
    ],
  });
  const resting = "Hyperliquid fill it at $90,000 or better until you cancel";

  // One tap allows every move, so the plan says what each leaves before it, whoever wrote its face.
  it("says what each move leaves able to act on the money, under its own name", () => {
    expect(
      planPermissions({
        legs: [
          leg("Move $50 to Arbitrum"),
          leg("Send it", "0x1a2b…9f8e spend your USDC"),
          leg("Place a limit order to go long BTC", resting),
          leg("Place a limit order to go long ETH", resting),
        ],
        moves: [],
      }),
    ).toEqual([
      "Send it: From now on, it lets 0x1a2b…9f8e spend your USDC.",
      `Place a limit order to go long BTC: From now on, it lets ${resting}.`,
      `Place a limit order to go long ETH: From now on, it lets ${resting}.`,
    ]);
  });

  // Telegram draws every row's permissions; the web drew only its legs', never a cash move's.
  it("says what a move that brings the plan's cash leaves too, first, as it runs first", () => {
    expect(
      planPermissions({
        legs: [leg("Buy $5 of NVIDIA")],
        moves: [
          { name: "Move $5 from Base to Monad", lets: "0x1a2b…9f8e spend your USDC" },
          { name: "Take $3 out of savings" },
        ],
      }),
    ).toEqual(["Move $5 from Base to Monad: From now on, it lets 0x1a2b…9f8e spend your USDC."]);
  });

  it("says nothing for a plan that leaves none", () => {
    expect(
      planPermissions({
        legs: [leg("Move $50 to Arbitrum"), { summary: "x", lines: [] }],
        moves: [{ name: "Take $3 out of savings" }],
      }),
    ).toEqual([]);
  });
});
