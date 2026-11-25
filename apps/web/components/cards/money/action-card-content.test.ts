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
    // A medium value keeps to one of a wider card's columns, so it leaves no gap beside it.
    expect(figureWidth({ value: "2.5 USDC ($2.50), 1 MON ($0.02)" }, false)).toBe("wide");
    expect(figureWidth({ value: "2.5 USDC ($2.50), 1 MON ($0.02), 4 WPRL" }, false)).toBe("row");
    // What it is worth, said beside it, counts too.
    expect(figureWidth({ value: "18.97 WPRL", note: "$25.00" }, false)).toBe("wide");
    expect(figureWidth({ value: "0x97c5e2b14D8A6F3c0E9b7A51D2c4F86e3a1D0b91" }, true)).toBe("row");
  });
});

describe("planPermissions", () => {
  const permission = (lets: string) => ({ says: `From now on, it lets ${lets}.` });
  const order = (lets: string) => ({ ...permission(lets), order: true as const });
  const face = (leaves?: CardFace["leaves"], warning?: string): CardFace => ({
    ...sale,
    ...(warning ? { warning } : {}),
    ...(leaves ? { leaves } : {}),
  });
  const leg = (summary: string, card = face()) => ({ summary, card });

  // One tap allows every move, so the plan says all they leave before it, whoever wrote its face.
  it("says each permission and order of every move as its own entry, permissions first", () => {
    const stop = order(
      "Hyperliquid close your whole BTC long, the part you hold now included, at market if BTC reaches $90,000",
    );
    expect(
      planPermissions({
        legs: [
          leg("Go long BTC", face([stop])),
          leg(
            "Send it",
            face([
              permission("0x1a2b…9f8e spend your USDC"),
              permission("0x3c4d…7a6b spend your WETH"),
            ]),
          ),
          leg("Move $50 to Arbitrum"),
        ],
        moves: [],
      }),
    ).toEqual([
      { says: "Send it: From now on, it lets 0x1a2b…9f8e spend your USDC.", order: false },
      { says: "Send it: From now on, it lets 0x3c4d…7a6b spend your WETH.", order: false },
      { says: `Go long BTC: ${stop.says}`, order: true },
    ]);
  });

  // Two legs can leave the same words (a limit at one price on two markets): each is its own tap's.
  it("never folds alike entries from different moves into one", () => {
    const resting = order("Hyperliquid fill your BTC long at $5.00 or better until you cancel");
    expect(
      planPermissions({
        legs: [leg("Buy A", face([resting])), leg("Buy B", face([resting]))],
        moves: [],
      }),
    ).toEqual([
      { says: `Buy A: ${resting.says}`, order: true },
      { says: `Buy B: ${resting.says}`, order: true },
    ]);
  });

  it("says money a leg sends for good, as its card's warning does", () => {
    expect(
      planPermissions({ legs: [leg("Send it", face(undefined, "Gone for good."))], moves: [] }),
    ).toEqual([{ says: "Send it: Gone for good.", order: false }]);
  });

  // Telegram draws every row's permissions; the web drew only its legs', never a cash move's.
  it("says what a move that brings the plan's cash leaves too, first, as it runs first", () => {
    expect(
      planPermissions({
        legs: [leg("Buy $5 of NVIDIA", face([permission("0x5e6f…1c2d spend your USDC")]))],
        moves: [
          { name: "Move $5 from Base to Monad", lets: "0x1a2b…9f8e spend your USDC" },
          { name: "Take $3 out of savings" },
        ],
      }),
    ).toEqual([
      {
        says: "Move $5 from Base to Monad: From now on, it lets 0x1a2b…9f8e spend your USDC.",
        order: false,
      },
      { says: "Buy $5 of NVIDIA: From now on, it lets 0x5e6f…1c2d spend your USDC.", order: false },
    ]);
  });

  it("says nothing for a plan that leaves none", () => {
    expect(
      planPermissions({
        legs: [leg("Move $50 to Arbitrum"), leg("x", face([]))],
        moves: [{ name: "Take $3 out of savings" }],
      }),
    ).toEqual([]);
  });
});
