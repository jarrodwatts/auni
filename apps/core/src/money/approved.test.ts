import { describe, expect, it, vi } from "vitest";

import {
  approvedEffect,
  approvedPrice,
  APPROVED_PRICE_AT_LEAST,
  APPROVED_PRICE_AT_MOST,
  APPROVED_PROCEEDS,
  APPROVED_SALE,
  assertApprovedProceeds,
  assertApprovedSale,
  assertApprovedSpend,
  assertBytesDo,
  assertStillAsShown,
  insideApproved,
  PriceMoved,
  quoteHoldingProceeds,
} from "./approved.ts";
import { pinnedApproval, type Effect, type Grant } from "./effect.ts";
import type { TokenGrant, WalletEffect } from "./wallet-effect.ts";

describe("assertApprovedSale", () => {
  const approved = { amountUsd: "0.00", details: { [APPROVED_SALE]: "10.5" } };

  it("lets a sell send up to the quantity that was allowed", () => {
    expect(() => assertApprovedSale(approved, 10_500_000n, 6)).not.toThrow();
  });

  it("refuses one base unit more, however the price moved", () => {
    expect(() => assertApprovedSale(approved, 10_500_001n, 6)).toThrow(/Nothing was sent/u);
  });

  it("leaves a move that named no sale alone", () => {
    expect(() => assertApprovedSale({ amountUsd: "0", details: {} }, 99n, 6)).not.toThrow();
  });
});

describe("assertApprovedSpend", () => {
  const approved = { amountUsd: "100.00", details: {} };

  it("allows the approved dollars plus the recipe's own slippage, and no more", () => {
    expect(() => assertApprovedSpend(approved, 101_000_000n, 100)).not.toThrow();
    expect(() => assertApprovedSpend(approved, 101_000_001n, 100)).toThrow(/Nothing was sent/u);
    expect(() => assertApprovedSpend(approved, 100_000_001n)).toThrow();
  });
});

describe("assertApprovedProceeds", () => {
  const approved = { amountUsd: "99.00", details: { [APPROVED_PROCEEDS]: "98.01" } };

  it("lets a trade go that gets exactly what the card said at least", () => {
    expect(() => assertApprovedProceeds(approved, 98_010_000n, 6)).not.toThrow();
  });

  it("refuses a quote one base unit under, the price having fallen past its slippage", () => {
    expect(() => assertApprovedProceeds(approved, 98_009_999n, 6)).toThrow(/Nothing was sent/u);
  });

  it("leaves a move whose card promised no floor alone", () => {
    expect(() => assertApprovedProceeds({ amountUsd: "0", details: {} }, 1n, 6)).not.toThrow();
  });
});

// A Hyperliquid market order keeps the worst price its card showed (see order.ts).
describe("approvedPrice", () => {
  const long = { details: { [APPROVED_PRICE_AT_MOST]: "101.5" } };
  const short = { details: { [APPROVED_PRICE_AT_LEAST]: "98.5" } };

  it("lets an order go at its fresh worst price while that's inside the card's", () => {
    expect(approvedPrice(long, { mark: 100, quoted: "101" })).toBe("101");
    expect(approvedPrice(short, { mark: 100, quoted: "99" })).toBe("99");
  });

  it("holds a fresh worst price past the card's to the card's", () => {
    expect(approvedPrice(long, { mark: 101, quoted: "102.01" })).toBe("101.5");
    expect(approvedPrice(short, { mark: 99, quoted: "98.01" })).toBe("98.5");
  });

  it("refuses an order whose market is already past the card's worst, with nothing sent", () => {
    expect(() => approvedPrice(long, { mark: 101.6, quoted: "102.6" })).toThrow(PriceMoved);
    expect(() => approvedPrice(short, { mark: 98.4, quoted: "97.4" })).toThrow(PriceMoved);
  });

  it("lets an order whose card kept no worst price go as quoted, as before", () => {
    expect(approvedPrice({ details: {} }, { mark: 500, quoted: "505" })).toBe("505");
  });
});

describe("insideApproved", () => {
  const approved = {
    details: { [APPROVED_PROCEEDS]: "98.01", [APPROVED_SALE]: "1.5", market: "BTC" },
  };

  it("is inside while it gets no less and sells no more", () => {
    expect(insideApproved(approved, approved)).toBe(true);
    expect(
      insideApproved(approved, { details: { [APPROVED_PROCEEDS]: "99", [APPROVED_SALE]: "1.4" } }),
    ).toBe(true);
  });

  it("is outside once it would get less, sell more or pay a worse price", () => {
    expect(insideApproved(approved, { details: { [APPROVED_PROCEEDS]: "98.009" } })).toBe(false);
    expect(insideApproved(approved, { details: { [APPROVED_SALE]: "1.6" } })).toBe(false);
    expect(
      insideApproved(
        { details: { [APPROVED_PRICE_AT_MOST]: "101.5" } },
        { details: { [APPROVED_PRICE_AT_MOST]: "101.6" } },
      ),
    ).toBe(false);
  });
});

// The least a card said it gets is what the swap's own transaction lets land, not just what its
// fresh quote expects.
describe("quoteHoldingProceeds", () => {
  // A card that said at least 99 USDC.
  const approved = { amountUsd: "0", details: { [APPROVED_PROCEEDS]: "99" } };
  // A venue expecting `expected` units, whose transaction lets land one slippage under that.
  const venue = (expected: bigint) =>
    vi.fn(async (slippageBps: number) => ({
      expected,
      least: (expected * BigInt(10_000 - slippageBps)) / 10_000n,
    }));
  const paid = (quote: { expected: bigint; least: bigint }) => quote;

  it("builds at the card's slippage while what that lets land still reaches the card", async () => {
    const build = venue(100_000_000n);
    const quote = await quoteHoldingProceeds(approved, 6, 100, build, paid);
    expect(build.mock.calls).toEqual([[100]]);
    expect(quote.least).toBe(99_000_000n);
  });

  it("narrows the slippage once the price falls, so the transaction never lets less land than was shown", async () => {
    // Expecting 99.50, 1% would let 98.505 land: under the 99 shown.
    const build = venue(99_500_000n);
    const quote = await quoteHoldingProceeds(approved, 6, 100, build, paid);
    expect(build.mock.calls).toEqual([[100], [50]]);
    expect(quote.least).toBeGreaterThanOrEqual(99_000_000n);
  });

  it("keeps the card's least to the base unit when it narrows", async () => {
    const build = venue(99_000_001n);
    const quote = await quoteHoldingProceeds(approved, 6, 100, build, paid);
    expect(build.mock.calls).toEqual([[100], [0]]);
    expect(quote.least).toBe(99_000_001n);
  });

  it("sends nothing once even what it expects falls under the card", async () => {
    const build = venue(98_999_999n);
    await expect(quoteHoldingProceeds(approved, 6, 100, build, paid)).rejects.toThrow(
      /Nothing was sent/u,
    );
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the narrowed build still lets less land, the price having fallen again", async () => {
    const build = vi
      .fn<(slippageBps: number) => Promise<{ expected: bigint; least: bigint }>>()
      .mockResolvedValueOnce({ expected: 99_500_000n, least: 98_505_000n })
      .mockResolvedValueOnce({ expected: 99_200_000n, least: 98_704_000n });
    await expect(quoteHoldingProceeds(approved, 6, 100, build, paid)).rejects.toThrow(
      /Nothing was sent/u,
    );
  });

  it("sends nothing, building nothing, for a card that pinned no least it gets", async () => {
    const build = venue(100_000_000n);
    await expect(
      quoteHoldingProceeds({ amountUsd: "0", details: {} }, 6, 100, build, paid),
    ).rejects.toThrow("This card doesn't say the least it gets. Nothing was sent.");
    expect(build).not.toHaveBeenCalled();
  });
});

// A raw transaction is held at execute to the card its tap or code vouched for.
describe("assertStillAsShown", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const TOKEN = "0x1111111111111111111111111111111111111111" as const;
  const FRIEND = "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2";
  const simulated = (sent: bigint, got: bigint): WalletEffect => ({
    out: [{ token: USDC, amount: sent }],
    in: [{ token: TOKEN, amount: got }],
    grants: [],
  });
  const trade: Effect = { gives: [{ text: "5 USDC" }], gets: [{ text: "100 PRL" }], grants: [] };
  const approved = { amountUsd: "5.00", details: approvedEffect(simulated(5_000_000n, 100n)) };
  const SPENDER = "0xAbCd000000000000000000000000000000001234" as const;
  const spends = (exact: Partial<TokenGrant> = {}): Grant => ({
    lets: "0xAbCd…1234 spend your USDC",
    reach: "wallet",
    exact: { kind: "spend", contract: USDC, token: USDC, to: SPENDER, ...exact },
  });

  it("lets a raw transaction go while it sends no more and gets about what its card showed", () => {
    expect(() => assertStillAsShown(approved, trade, simulated(5_000_000n, 97n))).not.toThrow();
  });

  it("refuses one that now sends more, or gets clearly less", () => {
    const now = (sent: bigint, got: bigint) => () =>
      assertStillAsShown(approved, trade, simulated(sent, got));
    expect(now(5_000_001n, 100n)).toThrow(/send more/u);
    expect(now(5_000_000n, 96n)).toThrow(/get less/u);
  });

  it("refuses a permission or a blind call its card never showed, but sends one the owner's proof vouched for", () => {
    const now = simulated(5_000_000n, 100n);
    expect(() => assertStillAsShown(approved, { ...trade, grants: [spends()] }, now)).toThrow(
      "This now lets 0xAbCd…1234 spend your USDC, so nothing was sent.",
    );
    expect(() => assertStillAsShown(approved, { ...trade, blind: "it's blind" }, now)).toThrow(
      /it's blind/u,
    );
    const shown = { ...trade, grants: [spends()] };
    const vouched = { ...approved, details: { ...approved.details, ...pinnedApproval(shown) } };
    expect(() => assertStillAsShown(vouched, shown, now)).not.toThrow();
    // The same spender, its address in other letters' case.
    const lower = spends({ to: SPENDER.toLowerCase() as `0x${string}` });
    expect(() => assertStillAsShown(vouched, { ...trade, grants: [lower] }, now)).not.toThrow();
  });

  // Found in review: it compared each permission by its words, which name a spender by its first
  // and last four digits (anyone can make an address that shares them in seconds) and a token by
  // its symbol (anyone can name one USDC), so either swapped passed.
  it("refuses a permission whose words match what its card showed but is another, exactly", () => {
    const now = simulated(5_000_000n, 100n);
    const shown = { ...trade, grants: [spends()] };
    const vouched = { ...approved, details: { ...approved.details, ...pinnedApproval(shown) } };
    const other = (exact: Partial<TokenGrant>) => () =>
      assertStillAsShown(vouched, { ...trade, grants: [spends(exact)] }, now);
    expect(other({ to: "0xAbCd999999999999999999999999999999991234" })).toThrow(/now lets/u);
    expect(other({ token: TOKEN })).toThrow(/now lets/u);
    expect(other({ kind: "operator" })).toThrow(/now lets/u);
  });

  // Found in review: a token's allowance, Permit2's allowance over it and a credit delegation to
  // borrow it were pinned alike, by their token and holder, so one passed as another.
  it("refuses a permission over the same token and holder that is another kind, or another contract keeps", () => {
    const now = simulated(5_000_000n, 100n);
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const shown = { ...trade, grants: [spends({ kind: "permit", contract: PERMIT2 })] };
    const vouched = { ...approved, details: { ...approved.details, ...pinnedApproval(shown) } };
    const fresh = (exact: Partial<TokenGrant>) => () =>
      assertStillAsShown(vouched, { ...trade, grants: [spends(exact)] }, now);
    expect(fresh({ kind: "permit", contract: PERMIT2.toLowerCase() })).not.toThrow();
    expect(fresh({ kind: "permit", contract: TOKEN })).toThrow(/now lets/u);
    expect(fresh({})).toThrow(/now lets/u);
    expect(fresh({ kind: "borrow", contract: PERMIT2 })).toThrow(/now lets/u);
  });

  // Found in review: it pinned a permission by its kind, token and holder alone, so one over
  // another NFT of the same collection, or another of the owner's token accounts for the same
  // mint, passed as the one the card showed.
  it("refuses a permission over another NFT, or another token account, than its card showed", () => {
    const now = simulated(5_000_000n, 100n);
    const held = (exact: Partial<TokenGrant>) => {
      const shown = { ...trade, grants: [spends(exact)] };
      const vouched = { ...approved, details: { ...approved.details, ...pinnedApproval(shown) } };
      return (fresh: Partial<TokenGrant>) => () =>
        assertStillAsShown(vouched, { ...trade, grants: [spends(fresh)] }, now);
    };
    const nft = held({ id: "7" });
    expect(nft({ id: "7" })).not.toThrow();
    expect(nft({ id: "8" })).toThrow(/now lets/u);
    expect(nft({ id: undefined })).toThrow(/now lets/u);
    const account = held({ account: "6Fnf9PuEXNhbZbrmUxPirWHRQWt4VpxVbXywqM3xhFgg" });
    expect(account({ account: "6Fnf9PuEXNhbZbrmUxPirWHRQWt4VpxVbXywqM3xhFgg" })).not.toThrow();
    expect(account({ account: "FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq" })).toThrow(
      /now lets/u,
    );
    expect(
      account({ account: "6Fnf9PuEXNhbZbrmUxPirWHRQWt4VpxVbXywqM3xhFgg", kind: "close" }),
    ).toThrow(/now lets/u);
  });

  it("refuses a permission pinned by fewer parts than each is kept by now", () => {
    const now = simulated(5_000_000n, 100n);
    const details = {
      ...approved.details,
      needsStepUp: `lets ${spends().lets}`,
      grantsExactly: `spend:${USDC}:${SPENDER}`,
    };
    // As each was pinned before it kept the contract that keeps it.
    const unkept = { ...details, grantsExactly: `spend:${USDC}:${SPENDER}::` };
    for (const each of [details, unkept])
      expect(() =>
        assertStillAsShown({ ...approved, details: each }, { ...trade, grants: [spends()] }, now),
      ).toThrow(/now lets/u);
  });

  it("refuses a permission a card pinned only in words, as cards were before", () => {
    const now = simulated(5_000_000n, 100n);
    const details = { ...approved.details, needsStepUp: `lets ${spends().lets}` };
    expect(() =>
      assertStillAsShown({ ...approved, details }, { ...trade, grants: [spends()] }, now),
    ).toThrow(/now lets/u);
  });

  it("sends money leaving only where its card named, and never where Auni can't name", () => {
    const shown = { amountUsd: "5.00", details: { leavesTo: FRIEND } };
    const away = (to?: string[]): Effect => ({
      gives: [{ text: "5 USDC" }],
      gets: [],
      grants: [],
      ...(to ? { to } : {}),
    });
    expect(() => assertStillAsShown(shown, away([FRIEND.toLowerCase()]), null)).not.toThrow();
    expect(() => assertStillAsShown(shown, away([TOKEN]), null)).toThrow(/didn't show/u);
    // Now to a contract, which could pass it on to anyone.
    expect(() => assertStillAsShown(shown, away(), null)).toThrow(/didn't show/u);
  });
});

// Bytes a route or a bridge built are held to what Auni asked of them before they're signed.
describe("assertBytesDo", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH = "0x4200000000000000000000000000000000000006";
  const asked = {
    gives: [{ token: USDC, amount: 40_000_000n }],
    gets: [{ token: WETH, amount: 99n }],
  };
  const simulated = (out: bigint, got: bigint, to = WETH) => ({
    out: [{ token: USDC.toLowerCase(), amount: out }],
    in: [{ token: to, amount: got }],
    grants: [],
  });

  it("lets bytes go that send what was asked and land at least what was asked in the wallet", () => {
    expect(() => assertBytesDo(simulated(40_000_000n, 99n), asked)).not.toThrow();
  });

  it("refuses bytes that pay out somewhere else, so nothing lands in the wallet", () => {
    expect(() => assertBytesDo(simulated(40_000_000n, 0n), asked)).toThrow(/get less/u);
  });

  it("refuses bytes that take more, or take anything else", () => {
    expect(() => assertBytesDo(simulated(40_000_001n, 99n), asked)).toThrow(/send more/u);
    const other = { ...simulated(40_000_000n, 99n), out: [{ token: WETH, amount: 1n }] };
    expect(() => assertBytesDo(other, asked)).toThrow(/send more/u);
  });

  it("refuses bytes that leave a permission behind, such as an approval the move didn't spend", () => {
    const left = {
      ...simulated(40_000_000n, 99n),
      grants: [{ kind: "spend" as const, token: USDC, to: WETH }],
    };
    expect(() => assertBytesDo(left, asked)).toThrow(/permission/u);
  });

  it("signs nothing it couldn't simulate", () => {
    expect(() => assertBytesDo(null, asked)).toThrow(/couldn't check/u);
  });
});
