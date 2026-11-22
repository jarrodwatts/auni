import { actionCardSchema, AMOUNT, fillFace } from "@auni/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../db/schema.ts";
import { FACE, stubRecipe } from "../test/recipe.ts";
import {
  actionCard,
  cardVenue,
  moveCards,
  planAction,
  pricedLater,
  subjectLogo,
} from "./action-card.ts";
import { recipeForTool } from "./recipes/index.ts";
import { xStockCatalog, type XStock } from "./swaps/xstocks.ts";

const TESLA_MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";

vi.mock(import("./swaps/xstocks.ts"), async (original) => ({
  ...(await original()),
  xStockCatalog: vi.fn(async (): Promise<XStock[]> => [
    {
      symbol: "TSLAx",
      name: "Tesla xStock",
      ticker: "TSLA",
      logoUrl: "https://example.com/TSLA.png",
      solanaMint: TESLA_MINT,
      evmAddress: null,
    },
  ]),
}));
// No listing has art for these tokens but DexScreener's, the last token feed asked: each test
// says what it has, and every feed asked before it reads that answer and finds no art in it.
vi.mock(import("./swaps/solana-swap.ts"), async (original) => ({
  ...(await original()),
  solanaTokens: vi.fn(async () => []),
}));

function dexScreener(pairs: unknown[]) {
  const fetch = vi.fn(async () => Response.json(pairs));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("planAction", () => {
  const leg = (action: string, flow: "in" | "back" = "in", usd = "5", movesCash = false) => ({
    card: { action },
    movesCash,
    flow,
    amount: {
      baseUnits: String(Number(usd) * 1e6),
      currency: { code: "USDC" as const, decimals: 6 },
    },
  });

  it("names a plan for what all of it does, never after one of its moves", () => {
    // Live: savings out, a bridge, then a sale read "Sell for $1.98".
    expect(
      planAction([
        leg(`Take out ${AMOUNT}`, "in", "0", true),
        leg(`Move ${AMOUNT}`, "in", "0", true),
        leg(`Sell ${AMOUNT}`, "back", "1.98"),
      ]),
    ).toBe("Move and sell");
    // Cash brought home through two of the owner's places is one thing: moving it.
    expect(
      planAction([
        leg(`Withdraw ${AMOUNT}`, "in", "0", true),
        leg(`Move ${AMOUNT}`, "in", "0", true),
      ]),
    ).toBe("Move both");
    expect(planAction([leg("Close long", "back"), leg(`Save ${AMOUNT}`), leg("Sell Nvidia")])).toBe(
      "Close, save and sell",
    );
    expect(
      planAction([leg("Close long", "back"), leg("Close 50%", "back"), leg("Close short")]),
    ).toBe("Close all 3");
    expect(planAction([leg("Sell Nvidia", "back"), leg("Sell Tesla", "back")])).toBe("Sell both");
    expect(
      planAction([leg("Long BTC"), leg("Close short"), leg(`Save ${AMOUNT}`), leg("Cancel order")]),
    ).toBe("Make 4 moves");
  });

  it("says the money only where every move puts it in, so it is money that leaves", () => {
    expect(planAction([leg(`Buy ${AMOUNT}`), leg(`Buy ${AMOUNT}`)])).toBe(`Buy both for ${AMOUNT}`);
    expect(planAction([leg(`Buy ${AMOUNT}`), leg(`Buy ${AMOUNT}`, "in", "0")])).toBe("Buy both");
  });

  it("reads as a lone move's own button, whatever moves bring its cash", () => {
    // Live: a bridge then a Polymarket bet read "Start with $1.07".
    expect(planAction([leg(`Buy ${AMOUNT}`, "in", "1.07")])).toBe(`Buy ${AMOUNT}`);
    expect(planAction([leg("Long BTC", "in", "1000")])).toBe("Long BTC");
  });
});

describe("cardVenue", () => {
  it("wears an app's own mark, the mark a move of core's names, and Auni's mascot otherwise", () => {
    expect(cardVenue("hyperliquid")).toBe("hyperliquid");
    expect(cardVenue("polymarket")).toBe("polymarket");
    expect(cardVenue("jupiter")).toBe("jupiter");
    expect(cardVenue("aave")).toBe("aave");
    // Across has no mark of its own.
    expect(cardVenue("across")).toBe("auni");
    expect(cardVenue(null)).toBe("auni");
    // Core's own moves each name theirs, so this file names no venue of core's.
    const worn = (tool: string) => {
      const recipe = recipeForTool(tool)!;
      return cardVenue(recipe.venue, recipe);
    };
    expect(worn("stock_trade")).toBe("stocks");
    expect(worn("evm_swap")).toBe("swap");
    expect(worn("solana_swap")).toBe("swap");
    expect(worn("withdraw_usdc")).toBe("auni");
    // An app's mark is the app's, whatever a recipe filed under it says.
    expect(cardVenue("aave", { mark: "swap" })).toBe("aave");
  });
});

describe("subjectLogo", () => {
  it("shows cash between wallets as USDC, and leaves cash at a venue to the venue's own mark", async () => {
    expect(await subjectLogo({ kind: "cash", at: "wallet" }, "withdraw")).toEqual({
      src: "/brand/tokens/usdc.svg",
      name: "USDC",
    });
    for (const at of ["aave", "hyperliquid"] as const) {
      expect(await subjectLogo({ kind: "cash", at }, at)).toEqual({ src: null, name: null });
    }
  });

  it("knows a chain's own coin without waiting on the stock catalog", async () => {
    vi.mocked(xStockCatalog).mockClear();
    const weth = await subjectLogo(
      {
        kind: "token",
        chain: "base",
        // Wrapped ether on Base.
        mint: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        stock: false,
        buysUsd: 0,
      },
      null,
    );
    expect(weth).toEqual({ src: "/brand/chains/ethereum.svg", name: "Wrapped Ethereum" });
    expect(xStockCatalog).not.toHaveBeenCalled();
  });

  it("names a token nobody has art for, so the card draws its initials", async () => {
    dexScreener([]);
    const logo = await subjectLogo(
      {
        kind: "token",
        chain: "eip155:4663",
        mint: "0x77cd83A31e52e883B6f33Eb1540a41C4a8Dae56c",
        symbol: "PRL",
        stock: false,
        buysUsd: 0,
      },
      null,
    );
    expect(logo).toEqual({ src: null, name: "PRL" });
  });

  it("never wears a stock's logo for a token that only shares its symbol", async () => {
    dexScreener([]);
    const spoof = await subjectLogo(
      {
        kind: "token",
        chain: "solana",
        mint: "SpoofSpoofSpoofSpoofSpoofSpoofSpoofSpoof111",
        symbol: "TSLAx",
        stock: false,
        buysUsd: 0,
      },
      null,
    );
    expect(spoof).toEqual({ src: null, name: "TSLAx" });
    const tesla = await subjectLogo(
      {
        kind: "token",
        chain: "solana",
        mint: TESLA_MINT,
        symbol: "TSLAx",
        stock: true,
        buysUsd: 0,
      },
      null,
    );
    // The real stock wears the art its own listing gives.
    expect(tesla.src).toBe("https://example.com/TSLA.png");
  });

  it("takes a token's art from its own side of a DexScreener pair", async () => {
    const token = "0x6c0aeceeDc55c9d55d8B99216a670D85330941c3";
    const fetch = dexScreener([
      // A pair it quotes carries the other token's artwork.
      {
        baseToken: { address: "0x1111111111111111111111111111111111111111" },
        info: { imageUrl: "https://cdn.dexscreener.com/other.png" },
      },
      {
        baseToken: { address: token.toLowerCase() },
        info: { imageUrl: "https://cdn.dexscreener.com/prl.png" },
      },
    ]);
    const logo = await subjectLogo(
      {
        kind: "token",
        chain: "eip155:1",
        mint: token,
        symbol: "PRL",
        stock: false,
        buysUsd: 0,
      },
      null,
    );
    expect(logo.src).toBe("https://cdn.dexscreener.com/prl.png");
    expect(fetch).toHaveBeenCalledWith(
      `https://api.dexscreener.com/tokens/v1/ethereum/${token}`,
      expect.anything(),
    );
  });

  it("wears a market's own picture, else its venue's", async () => {
    const outcome = { kind: "outcome", market: "will-it", buysUsd: 5 } as const;
    const image = "https://polymarket-upload.s3.us-east-2.amazonaws.com/a.png";
    expect((await subjectLogo({ ...outcome, image }, "polymarket")).src).toBe(image);
    expect((await subjectLogo(outcome, "polymarket")).src).toBe("/logos/polymarket.svg");
  });

  it("wears a perp's face as its venue gives it", async () => {
    expect(await subjectLogo({ kind: "perp", market: "BTC" }, "hyperliquid")).toEqual({
      src: "https://app.hyperliquid.xyz/coins/BTC.svg",
      name: "BTC",
    });
  });
});

describe("pricedLater", () => {
  const row = (fields: Partial<ActionRow>) =>
    ({
      id: fields.tool,
      input: {},
      amountUsd: "0",
      details: {},
      card: null,
      run: {},
      status: "awaiting_permission",
      phase: null,
      ...fields,
    }) as ActionRow;
  const savings = row({
    tool: "aave_withdraw",
    input: { chain: "monad", amount_usd: "1" },
    amountUsd: "1.00",
  });
  const bridge = row({
    tool: "bridge_usdc",
    input: { from_chain: "polygon", to_chain: "monad", amount: "1.25" },
    amountUsd: "1.25",
    details: { getsAtLeast: "1.21" },
  });
  const sale = row({
    tool: "evm_swap",
    input: { chain: "monad", sellToken: "WETH", buyToken: "USDC" },
    summary: "Swap 0.0005 WETH (about $1.98) for about 1.98 USDC on Monad",
    details: { getsAtLeast: "1.96" },
  });

  it("says a trade that waits for the card's money moves is priced again when its turn comes", () => {
    // Live: savings out, a bridge, then a WETH sale run three minutes on that failed its 1% floor.
    expect(pricedLater([savings, bridge, sale])).toBe(
      "Swap 0.0005 WETH (about $1.98) for about 1.98 USDC on Monad waits for the moves before it to land and is priced again then. If its price has moved past what this card allows, it doesn't go, and Auni tells you.",
    );
    // A move's own face names it, with its dollars in.
    const long = row({
      tool: "hyperliquid_order",
      amountUsd: "1000.00",
      details: { priceAtMost: "92000" },
      card: { ...FACE, title: `Long BTC with ${AMOUNT} at 3x` },
    });
    expect(pricedLater([bridge, long])).toMatch(/^Long BTC with \$1,000 at 3x waits for/u);
  });

  it("says nothing of trades that go at once, or that pin no price", () => {
    expect(pricedLater([sale, { ...sale, id: "second" }])).toBeNull();
    // A limit order rests at its own price, however late it is placed.
    expect(pricedLater([bridge, row({ tool: "hyperliquid_order" })])).toBeNull();
    // A bridge's least is what it may lose on the way, not a price.
    expect(pricedLater([savings, bridge])).toBeNull();
  });
});

describe("moveCards", () => {
  const row = (id: string, tool: string, input: Record<string, unknown>, amountUsd: string) =>
    ({
      id,
      tool,
      input,
      amountUsd,
      details: {},
      run: {},
      status: "running",
      phase: "queued",
    }) as ActionRow;

  it("lists moves in the order they run, each saying where its money waits", () => {
    const bridge = row(
      "bridge",
      "bridge_usdc",
      { from_chain: "arbitrum", to_chain: "monad", amount: "6" },
      "6.00",
    );
    const withdraw = row("withdraw", "hyperliquid_withdraw", { amountUsd: 7 }, "7.00");
    const savings = row("savings", "aave_withdraw", { chain: "base", amount_usd: "3" }, "3.00");
    expect(moveCards([bridge, withdraw, savings])).toEqual([
      {
        actionReference: "withdraw",
        name: "Take $7 out of Hyperliquid, which keeps $1",
        from: "Hyperliquid",
        lands: "arbitrum",
        status: "running",
      },
      {
        actionReference: "savings",
        name: "Take $3 out of savings",
        from: "your savings",
        lands: "base",
        status: "running",
      },
      {
        actionReference: "bridge",
        name: "Move $6 from Arbitrum to Monad",
        from: "your Arbitrum wallet",
        lands: "monad",
        status: "running",
      },
    ]);
  });

  it("names a token sold home as the sale it is, not a move of cash", () => {
    const sale = {
      ...row(
        "sale",
        "bridge_usdc",
        {
          from_chain: "1",
          from_token: "0x07696DcaB55E62cfef953666b29Fe1970518cB00",
          to_chain: "monad",
          amount: "1.0254",
        },
        "1.88",
      ),
      summary: "Sell 1.0254 WPRL on Ethereum for USDC on Monad",
      details: { returnsUsd: "1.91" },
    };
    expect(moveCards([sale])).toEqual([
      {
        actionReference: "sale",
        name: "Sell 1.0254 WPRL on Ethereum for USDC on Monad",
        lands: "monad",
        status: "running",
      },
    ]);
  });
});

describe("actionCard", () => {
  const row = (fields: Partial<ActionRow>) =>
    ({
      id: "00000000-0000-4000-8000-0000000000c1",
      summary: "Close your xyz:META position",
      amountUsd: "0",
      status: "done",
      venue: "test",
      tool: "stock_trade",
      input: {},
      lines: [{ label: "Market", value: "xyz:META" }],
      details: {},
      run: {},
      card: null,
      error: null,
      updatedAt: new Date(0),
      ...fields,
    }) as ActionRow;

  it("carries the face its move wrote, as it was kept", async () => {
    const card = await actionCard(row({ card: FACE, amountUsd: "50" }), stubRecipe());
    expect(card.card).toEqual(FACE);
    expect(fillFace(card.card, card.amount).title).toBe("Buy Nvidia for $50");
    expect(actionCardSchema.safeParse(card).success).toBe(true);
  });

  it("says a move that wrote none in the plain face, from its sentence, its lines and its money", async () => {
    const card = await actionCard(row({ details: { returnsUsd: "41.20" } }), stubRecipe());
    expect(fillFace(card.card, card.amount)).toMatchObject({
      title: "Close your xyz:META position",
      action: "Close",
      figures: [{ label: "Market", value: "xyz:META" }],
      receipt: { title: "Closed your xyz:META position", amount: "$41.20 back" },
    });
    expect(actionCardSchema.safeParse(card).success).toBe(true);
  });

  it("says the plain face of the card as it stands: where the money landed, once core knows", async () => {
    const landed = row({ details: { returnsUsd: "41.20" }, run: { lands: "USDC on Monad" } });
    expect((await actionCard(landed, stubRecipe())).card.receipt.detail).toBe(
      "Arrives as USDC on Monad",
    );
  });

  // Live, 2026-11-14: only the AI's own words warned that 0x000...dEaD burns what it is sent.
  it("says on any face that what it sends where nobody can spend it is gone for good", async () => {
    const burn = "0x000000000000000000000000000000000000dEaD";
    const plain = await actionCard(row({ details: { leavesTo: burn } }), stubRecipe());
    expect(plain.card.warning).toBe(
      "0x0000…dEaD is a burn address: nobody can ever spend from it. What this sends there is gone for good.",
    );
    const warned = { ...FACE, warning: "It lets 0x1a2b…9f8e spend your USDC afterwards." };
    const written = await actionCard(
      row({ card: warned, details: { leavesTo: `0x${"7".repeat(40)},${burn}` } }),
      stubRecipe(),
    );
    expect(written.card.warning).toMatch(/^0x0000…dEaD is a burn address.* It lets 0x1a2b/u);
    expect(actionCardSchema.safeParse(written).success).toBe(true);
    // A send to someone who can spend it says nothing of the kind.
    const friend = await actionCard(
      row({ details: { leavesTo: `0x${"7".repeat(40)}` } }),
      stubRecipe(),
    );
    expect(friend.card.warning).toBeUndefined();
  });

  it("draws a card however long the agent's own sentence is", async () => {
    const long = row({ summary: `Put ${"very ".repeat(200)}much in`, amountUsd: "5" });
    expect(actionCardSchema.safeParse(await actionCard(long, stubRecipe())).success).toBe(true);
  });
});
