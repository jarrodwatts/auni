import { AMOUNT, NETWORKS } from "@auni/shared";
import {
  encodeAbiParameters,
  pad,
  toEventSelector,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { figureOf } from "../../test/recipe.ts";
import { EVM_NATIVE, evmTokenKey, fillIdentity } from "../fill-key.ts";
import { moneyOf, NothingMoved, type Signer } from "../recipe.ts";
import { executeEvmSwap, previewEvmSwap, readBackEvmSwap } from "./evm-swap.ts";
import {
  evmBalance,
  resolveEvmToken,
  slippageFloor,
  type EvmQuoteRequest,
  type EvmRoute,
  type EvmToken,
} from "./evm.ts";
import { quoteSwap } from "./routes.ts";
import { tokenCalled } from "../holdings.ts";

vi.mock(import("./evm.ts"), async (original) => ({
  ...(await original()),
  resolveEvmToken: vi.fn(),
  evmBalance: vi.fn(),
}));
vi.mock(import("./routes.ts"), async (original) => ({ ...(await original()), quoteSwap: vi.fn() }));
// What a token's list calls it, as a test says; offline, a token goes by its symbol.
vi.mock(import("../holdings.ts"), async (original) => ({
  ...(await original()),
  tokenCalled: vi.fn(async () => null),
}));
// The chain a read back asks for receipts: each hash's, as a test sets them.
const receipts = new Map<string, { status: string; logs: Log[] }>();
vi.mock(import("../chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: (() => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const found = receipts.get(hash);
      if (!found) throw new TransactionReceiptNotFoundError({ hash: hash as Hex });
      return found;
    },
  })) as never,
}));

const usdc: EvmToken = { address: NETWORKS.base.usdc, symbol: "USDC", decimals: 6, usdPrice: 1 };
const weth: EvmToken = {
  address: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  decimals: 18,
  usdPrice: 4_000,
};

// Only USDC paid in is cash a swap spends; what a sell gets back is recorded apart from it.
describe("previewEvmSwap", () => {
  const other: EvmToken = { ...weth, address: "0x0000000000000000000000000000000000000001" };
  const mon: EvmToken = { address: EVM_NATIVE, symbol: "MON", decimals: 18, usdPrice: 0.03 };
  const tokens: Record<string, EvmToken> = { USDC: usdc, WETH: weth, OTHER: other, MON: mon };
  vi.mocked(resolveEvmToken).mockImplementation(async (_, token) => tokens[token]!);
  // The route pays out $39.50 of USDC for 0.01 WETH.
  vi.mocked(quoteSwap).mockImplementation(async (request) => ({
    provider: "KyberSwap",
    buyAmount: request.buyToken === usdc.address ? 39_500_000n : 10n ** 16n,
    minBuyAmount: request.buyToken === usdc.address ? 39_100_000n : 99n * 10n ** 14n,
  }));
  const owner = async () => "0x0000000000000000000000000000000000000002";
  const recorded = async (sellToken: string, buyToken: string, sellAmount: number) => {
    const input = { chain: "base" as const, sellToken, buyToken, sellAmount };
    const { amountUsd, details = {} } = await previewEvmSwap(input, owner);
    return { input, details, run: {}, amountUsd };
  };

  it("spends nothing on a sell, and records what the route pays out as coming back", async () => {
    const sold = await recorded("WETH", "USDC", 0.01);
    expect(sold.amountUsd).toBe("0");
    expect(sold.details).toMatchObject({ getsAtLeast: "39.1", returnsUsd: "39.50" });
    expect(moneyOf(sold)).toEqual({ flow: "back", usd: "39.50" });
  });

  it("reads a token bought for cash as a trade: what its list calls it, and the services it goes through", async () => {
    vi.mocked(tokenCalled).mockResolvedValueOnce("Wrapped Ether");
    vi.mocked(quoteSwap).mockResolvedValueOnce({
      provider: "KyberSwap",
      buyAmount: 10n ** 16n,
      minBuyAmount: 99n * 10n ** 14n,
      filledOn: ["Kuru", "PancakeSwap"],
    });
    const input = { chain: "base" as const, sellToken: "USDC", buyToken: "WETH", amountUsd: 40 };
    const preview = await previewEvmSwap(input, owner);
    expect(preview.card).toMatchObject({
      title: `Buy Wrapped Ether for ${AMOUNT}`,
      context: "WETH on Base",
      receipt: { title: "Bought Wrapped Ether", detail: "About 0.01 WETH" },
    });
    expect(figureOf(preview, "Through")).toBe("KyberSwap, filled on Kuru and PancakeSwap");
    // Recorded with the card, so Activity can say it once it's done.
    expect(preview.details?.through).toBe("KyberSwap, filled on Kuru and PancakeSwap");
  });

  it("spends the USDC a buy pays in", async () => {
    const bought = await recorded("USDC", "WETH", 40);
    expect(bought.amountUsd).toBe("40.00");
    expect(moneyOf(bought)).toEqual({ flow: "in", usd: "40.00" });
  });

  it("spends no cash swapping one holding for another, and brings none back", async () => {
    const swapped = await recorded("WETH", "OTHER", 0.01);
    expect(swapped.amountUsd).toBe("0");
    expect(moneyOf(swapped)).toBeNull();
  });

  it("sells the exact balance when no amount is named, leaving no crumb behind", async () => {
    // More digits than a float carries, which a decimal amount would round off.
    vi.mocked(evmBalance).mockResolvedValue(10_000_000_000_000_007n);
    const input = { chain: "base" as const, sellToken: "WETH", buyToken: "USDC" };
    const { sells } = await previewEvmSwap(input, owner);
    expect(sells?.quantity).toBe("0.010000000000000007");
  });

  it("sells only a specialist's own share when no amount is named, never another's", async () => {
    vi.mocked(evmBalance).mockResolvedValue(10n ** 16n);
    const specialistHolds = new Map([
      [fillIdentity(evmTokenKey("base", weth.address)), 4n * 10n ** 15n],
    ]);
    const input = { chain: "base" as const, sellToken: "WETH", buyToken: "USDC" };
    const { sells } = await previewEvmSwap(input, owner, { specialistHolds });
    expect(sells?.quantity).toBe("0.004");
  });

  // Monad reverts any move taking a delegated wallet's MON below 10, and Auni's wallet is delegated.
  it("keeps Monad's 10 MON reserve when selling all of it", async () => {
    vi.mocked(evmBalance).mockResolvedValue(25n * 10n ** 18n);
    const input = { chain: "monad" as const, sellToken: "MON", buyToken: "USDC" };
    const { sells } = await previewEvmSwap(input, owner);
    expect(sells?.quantity).toBe("15");
  });

  it("says why MON within the reserve can't be sold", async () => {
    vi.mocked(evmBalance).mockResolvedValue(6n * 10n ** 18n);
    const all = { chain: "monad" as const, sellToken: "MON", buyToken: "USDC" };
    await expect(previewEvmSwap(all, owner)).rejects.toThrow(
      "Monad keeps 10 MON in the wallet as a reserve that can't be sold, so none of its 6 MON can be.",
    );
    vi.mocked(evmBalance).mockResolvedValue(25n * 10n ** 18n);
    await expect(previewEvmSwap({ ...all, sellAmount: 20 }, owner)).rejects.toThrow(
      "so only 15 of its 25 MON can be.",
    );
  });

  it("names what a swap into another token sells, so execute can't sell more", async () => {
    const input = {
      chain: "base" as const,
      sellToken: "WETH",
      buyToken: "OTHER",
      sellAmount: 0.01,
    };
    const { sells } = await previewEvmSwap(input, owner);
    expect(sells?.quantity).toBe("0.01");
  });
});

// A Monad stock trade: priced by its Solana twin, quoted by every venue, sent by the route that won.
describe("Monad stock swaps", () => {
  const usdcMonad: EvmToken = {
    address: NETWORKS.monad.usdc,
    symbol: "USDC",
    decimals: 6,
    usdPrice: 1,
  };
  const nvdax: EvmToken = {
    address: "0x0000000000000000000000000000000000000a11",
    symbol: "NVDAx",
    decimals: 18,
    usdPrice: null,
  };
  const owner = "0x0000000000000000000000000000000000000002";
  const send = vi.fn<NonNullable<EvmRoute["send"]>>();
  // $100 buys 0.5 NVDAx, and 1 NVDAx sells for $180.
  const quote = vi.fn(async (request: EvmQuoteRequest): Promise<EvmRoute> => {
    const buyAmount = request.buyToken === nvdax.address ? 5n * 10n ** 17n : 180_000_000n;
    return {
      provider: "KyberSwap",
      buyAmount,
      minBuyAmount: buyAmount,
      send,
    };
  });
  const wallets = { evmAddress: owner } as Signer;
  const buy = { chain: "monad" as const, sellToken: "USDC", buyToken: "NVDAx", sellAmount: 100 };
  const sell = { chain: "monad" as const, sellToken: "NVDAx", buyToken: "USDC", sellAmount: 1 };
  // The tokens each card showed, by address, and the least it said each gets.
  const buys = { sellToken: usdcMonad.address, buyToken: nvdax.address, getsAtLeast: "0.5" };
  const sells = { sellToken: nvdax.address, buyToken: usdcMonad.address, getsAtLeast: "180" };
  const byName = (token: string) => (token === "USDC" ? usdcMonad : nvdax);

  beforeEach(() => {
    vi.mocked(resolveEvmToken).mockImplementation(async (_, token) =>
      token === usdcMonad.address ? usdcMonad : token === nvdax.address ? nvdax : byName(token),
    );
    vi.mocked(evmBalance).mockImplementation(async (_, token) =>
      token === usdcMonad.address ? 1_000_000_000n : 10n ** 18n,
    );
    send.mockResolvedValue({ txs: [{ chain: "monad", hash: "0xabc" }], received: 5n * 10n ** 17n });
    quote.mockClear();
  });

  it("prices the stock by the price it's given, and flags a buy losing past the limit", async () => {
    // 0.5 NVDAx at $190 is $95 for $100: 5% lost on the way in.
    const card = await previewEvmSwap(buy, async () => owner, {
      quote,
      stockUsd: 190,
      maxLossPct: 3,
      stock: {
        symbol: "NVDAx",
        name: "Nvidia xStock",
        ticker: "NVDA",
        logoUrl: "",
        solanaMint: null,
        evmAddress: null,
      },
    });
    expect(card.unpriced).toBe("loses on fill");
    // Its card says the loss in dollars.
    expect(card.card).toMatchObject({ price: "$190.00" });
    expect(figureOf(card, "Costs")).toBe("$5 price move");
    // At $192 it loses 4%, within the default 5% limit, so it is priced and acts on its own.
    const within = await previewEvmSwap(buy, async () => owner, { quote, stockUsd: 192 });
    expect(within.unpriced).toBeUndefined();
  });

  it("flags a sale losing past the limit, since a specialist's sales run without asking", async () => {
    // 1 NVDAx at $200 brings back $180.
    const card = await previewEvmSwap(sell, async () => owner, {
      quote,
      stockUsd: 200,
      maxLossPct: 3,
    });
    expect(card.unpriced).toBe("loses on fill");
    expect(card.effect.costs).toEqual([{ label: "price move", usd: 20 }]);
  });

  it("refuses at execute a buy whose fresh quote now gets less than its card said at least", async () => {
    const approved = { amountUsd: "100.00", details: { ...buys, getsAtLeast: "0.6" } };
    await expect(executeEvmSwap(buy, wallets, approved, { quote, stockUsd: 190 })).rejects.toThrow(
      "it would get less than was shown",
    );
    expect(send).not.toHaveBeenCalled();
  });

  // What its card said it gets at least is the bound a person saw, whatever the market's price.
  it("runs a buy whose fresh quote still reaches what its card said at least", async () => {
    const card = await previewEvmSwap(buy, async () => owner, { quote, stockUsd: 190 });
    expect(card.details).toMatchObject({ getsAtLeast: "0.5" });
    const approved = { amountUsd: "100.00", details: card.details! };
    await executeEvmSwap(buy, wallets, approved, { quote, stockUsd: 190 });
    expect(send).toHaveBeenCalled();
  });

  it("sends a buy whose price fell since its card only at a slippage that lands what the card said at least", async () => {
    // 0.505 NVDAx expected; at the card's 1% the swap would let 0.49995 land, under its 0.5.
    const sent = vi.fn<NonNullable<EvmRoute["send"]>>().mockResolvedValue({
      txs: [{ chain: "monad", hash: "0xabc" }],
      received: 505n * 10n ** 15n,
    });
    const fallen = vi.fn(async (request: EvmQuoteRequest): Promise<EvmRoute> => {
      const buyAmount = 505n * 10n ** 15n;
      const minBuyAmount = slippageFloor(buyAmount, request.slippageBps);
      return {
        provider: "KyberSwap",
        buyAmount,
        minBuyAmount,
        send: sent,
      };
    });
    const approved = { amountUsd: "100.00", details: { ...buys, getsAtLeast: "0.5" } };
    await executeEvmSwap(buy, wallets, approved, { quote: fallen, stockUsd: 190 });
    expect(fallen.mock.calls.map(([request]) => request.slippageBps)).toEqual([100, 99]);
    const route = await fallen.mock.results.at(-1)?.value;
    expect(route.minBuyAmount).toBeGreaterThanOrEqual(5n * 10n ** 17n);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("records what arrived and the venue that ran it", async () => {
    const approved = { amountUsd: "100.00", details: buys };
    const result = await executeEvmSwap(buy, wallets, approved, { quote });
    expect(result.fills).toMatchObject([{ side: "buy", quantity: "0.5", usdValue: "100" }]);
    expect(result.run).toEqual({
      venue: "KyberSwap",
      through: "KyberSwap",
      filled: "Got 0.5 NVDAx through KyberSwap",
    });
  });

  it("buys the token its card showed, even once its name means another", async () => {
    const card = await previewEvmSwap(buy, async () => owner, { quote });
    expect(card.details).toMatchObject(buys);
    const impostor: EvmToken = { ...nvdax, address: "0x0000000000000000000000000000000000000bad" };
    vi.mocked(resolveEvmToken).mockImplementation(async (_, token) =>
      token === "NVDAx" ? impostor : token === nvdax.address ? nvdax : usdcMonad,
    );
    await executeEvmSwap(buy, wallets, { amountUsd: "100.00", details: card.details! }, { quote });
    expect(quote.mock.calls.at(-1)?.[0].buyToken).toBe(nvdax.address);
  });

  it("records exactly what a maker paid from its own transaction, by which its arrival is known", async () => {
    send.mockResolvedValue({
      txs: [{ chain: "monad", hash: "0xopen" }],
      received: 5n * 10n ** 17n,
      makerPaid: true,
    });
    const approved = { amountUsd: "100.00", details: buys };
    const result = await executeEvmSwap(buy, wallets, approved, { quote });
    expect(result.run).toEqual({
      venue: "KyberSwap",
      through: "KyberSwap",
      filled: "Got 0.5 NVDAx through KyberSwap",
      landsUnits: "500000000000000000",
    });
  });

  // An xStock can credit a wei less than its buy logged, so a sale of what was recorded overshoots.
  it("sells the balance when the shares named are a crumb more than it", async () => {
    vi.mocked(evmBalance).mockResolvedValue(10n ** 18n - 1n);
    send.mockResolvedValue({ txs: [{ chain: "monad", hash: "0xabc" }], received: 180_000_000n });
    const approved = { amountUsd: "0", details: { ...sells, sellsUpTo: "1" } };
    const result = await executeEvmSwap(sell, wallets, approved, { quote });
    expect(quote.mock.calls[0]?.[0].sellAmount).toBe(10n ** 18n - 1n);
    expect(result.fills).toMatchObject([{ side: "sell", quantity: "0.999999999999999999" }]);
    // A sale of clearly more than the wallet holds is refused, not shrunk.
    vi.mocked(evmBalance).mockResolvedValue(9n * 10n ** 17n);
    await expect(executeEvmSwap(sell, wallets, approved, { quote })).rejects.toThrow(
      "Only 0.9 NVDAx on Monad, 1 needed.",
    );
  });

  it("records what a venue says it sold, when that is less than asked", async () => {
    vi.mocked(evmBalance).mockResolvedValue(10n ** 18n);
    send.mockResolvedValue({
      txs: [{ chain: "monad", hash: "0xabc" }],
      received: 180_000_000n,
      sold: 10n ** 18n - 1n,
    });
    const approved = { amountUsd: "0", details: { ...sells, sellsUpTo: "1" } };
    const result = await executeEvmSwap(sell, wallets, approved, { quote });
    expect(result.fills).toMatchObject([{ side: "sell", quantity: "0.999999999999999999" }]);
  });

  it("fails as nothing moved when the venue says nothing filled, and asks a person otherwise", async () => {
    const approved = { amountUsd: "100.00", details: buys };
    const note = "Not filled within a minute; nothing left the wallet.";
    send.mockResolvedValue({ txs: [{ chain: "monad", hash: "0xabc" }], received: 0n, note });
    const unfilled = executeEvmSwap(buy, wallets, approved, { quote });
    await expect(unfilled).rejects.toBeInstanceOf(NothingMoved);
    await expect(unfilled).rejects.toThrow(note);
    send.mockResolvedValue({ txs: [{ chain: "monad", hash: "0xabc" }], received: 0n });
    const empty = executeEvmSwap(buy, wallets, approved, { quote });
    await expect(empty).rejects.not.toBeInstanceOf(NothingMoved);
    await expect(empty).rejects.toThrow("landed but nothing arrived");
  });
});

// A run that stopped after its swap confirmed, before it read what arrived, is read back by
// reconcile from the receipts of everything it sent.
describe("readBackEvmSwap", () => {
  const owner: Address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const venue: Address = "0x2222222222222222222222222222222222222222";
  const transfer = (token: Address, from: Address, to: Address, amount: bigint) =>
    ({
      address: token,
      topics: [toEventSelector("Transfer(address,address,uint256)"), pad(from), pad(to)],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    }) as unknown as Log;
  const confirmed = (hash: string, ...logs: Log[]) =>
    receipts.set(hash, { status: "success", logs });
  const paid = (amount: bigint) => transfer(usdc.address, owner, venue, amount);
  const got = (amount: bigint) => transfer(weth.address, venue, owner, amount);
  const action = (txs: { chain: string; hash: string; setup?: true }[], sale?: string) => ({
    details: {
      chain: "base",
      sellToken: sale ? weth.address : usdc.address,
      buyToken: sale ? usdc.address : weth.address,
      ...(sale ? { sellsUpTo: sale } : {}),
    },
    txs,
  });
  const sent = [{ chain: "base", hash: "0xswap" }];

  beforeEach(() => {
    receipts.clear();
    vi.mocked(resolveEvmToken).mockImplementation(async (_, token) =>
      token === usdc.address ? usdc : weth,
    );
  });

  it("reads a buy as what the wallet received for the USDC it let go", async () => {
    confirmed("0xswap", paid(40_000_000n), got(99n * 10n ** 14n));
    expect(await readBackEvmSwap(action(sent), owner)).toEqual({
      fills: [
        { ...evmTokenKey("base", weth.address), side: "buy", quantity: "0.0099", usdValue: "40" },
      ],
    });
  });

  it("reads a sell as what it let go for the USDC it received", async () => {
    confirmed(
      "0xswap",
      transfer(weth.address, owner, venue, 10n ** 16n),
      transfer(usdc.address, venue, owner, 39_400_000n),
    );
    expect(await readBackEvmSwap(action(sent, "0.01"), owner)).toEqual({
      fills: [
        { ...evmTokenKey("base", weth.address), side: "sell", quantity: "0.01", usdValue: "39.4" },
      ],
    });
  });

  it("counts what a venue's own sweep brought home in a later send, and skips a send that never landed", async () => {
    confirmed("0xtrade", paid(40_000_000n));
    confirmed("0xsweep", got(99n * 10n ** 14n));
    const txs = [
      { chain: "base", hash: "0xstuck" },
      { chain: "base", hash: "0xtrade" },
      { chain: "base", hash: "0xsweep", setup: true as const },
    ];
    expect(await readBackEvmSwap(action(txs), owner)).toMatchObject({
      fills: [{ side: "buy", quantity: "0.0099", usdValue: "40" }],
    });
  });

  it("can't tell while what it sold is gone and nothing has arrived: a maker may yet pay", async () => {
    confirmed("0xswap", paid(40_000_000n));
    expect(await readBackEvmSwap(action(sent), owner)).toBeNull();
  });

  it("says nothing moved when all it sold came back", async () => {
    confirmed("0xopen", paid(40_000_000n));
    confirmed("0xrefund", transfer(usdc.address, venue, owner, 40_000_000n));
    const txs = [
      ...sent.map(() => ({ chain: "base", hash: "0xopen" })),
      { chain: "base", hash: "0xrefund" },
    ];
    expect(await readBackEvmSwap(action(txs), owner)).toBe("nothing moved");
  });

  it("reads nothing with no wallet, or before any of its sends confirmed", async () => {
    expect(await readBackEvmSwap(action(sent), owner)).toBeNull();
    confirmed("0xswap", paid(40_000_000n), got(1n));
    expect(await readBackEvmSwap(action(sent), null)).toBeNull();
  });
});
