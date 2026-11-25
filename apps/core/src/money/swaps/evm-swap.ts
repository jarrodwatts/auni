import { EVM_CASH_KEYS, NETWORKS, type EvmCashKey } from "@auni/shared";
import { getAddress } from "viem";
import { z } from "zod";

import type { ActionRow } from "../../db/schema.ts";
import {
  APPROVED_PROCEEDS,
  APPROVED_SALE,
  assertApprovedSale,
  assertApprovedSpend,
  pinnedToken,
  quoteHoldingProceeds,
  type Approved,
} from "../approved.ts";
import { RESERVES } from "../chains.ts";
import { EVM_NATIVE, evmTokenKey } from "../fill-key.ts";
import {
  NothingMoved,
  tradedToken,
  type ActionPreview,
  type ExecuteResult,
  type Fill,
  type ReadBack,
  type Recipe,
  type Signer,
} from "../recipe.ts";
import {
  coinMovedBy,
  confirmedReceipts,
  evmBalance,
  isEvmUsdc,
  receivedBy,
  resolveEvmToken,
  throughOf,
  type EvmQuoteRequest,
  type EvmRoute,
  type EvmToken,
} from "./evm.ts";
import { tradeFace, withFace, type TradeTerms } from "../card-face.ts";
import { formatAmount, priceLabel, usdLabel } from "../format.ts";
import { quoteSwap } from "./routes.ts";
import { formatUnits, parseUnits } from "../usd.ts";
import { walletEffect } from "../wallet-effect.ts";
import { evmAddress } from "../wallets.ts";
import { fromBaseUnits, MAX_BUY_IMPACT_PCT, toBaseUnits, tradeCosts, usd } from "./shared.ts";
import { tokenCalled } from "../holdings.ts";
import { stockName } from "./stock-index.ts";
import type { XStock } from "./xstocks.ts";

const input = {
  chain: z
    .enum(EVM_CASH_KEYS)
    .describe("Where the tokens are. Monad is where the owner's money usually rests."),
  sellToken: z
    .string()
    .min(1)
    .describe("USDC, the chain's native symbol (MON, ETH, POL), another symbol, or an address."),
  buyToken: z.string().min(1).describe("Same forms as sellToken."),
  sellAmount: z
    .number()
    .positive()
    .optional()
    .describe(
      "Amount of sellToken to sell, as the wallet shows it. Leave this and amountUsd out to sell all of it.",
    ),
  amountUsd: z.number().positive().optional().describe("Dollar value of sellToken to sell."),
  slippageBps: z.number().int().min(10).max(500).optional().describe("Defaults to 100 (1%)."),
};

export type EvmSwapInput = z.infer<z.ZodObject<typeof input>>;

/** How a caller quotes and judges a swap; evm_swap takes every default. */
export interface EvmSwapOptions {
  /** Where the route comes from: the routes that trade any pair by default, every route for a stock. */
  readonly quote?: (request: EvmQuoteRequest) => Promise<EvmRoute>;
  /** The dollar price of the swap's token that isn't USDC, when the caller knows it better than a token feed. */
  readonly stockUsd?: number | null;
}

interface SwapPlan {
  readonly chain: EvmCashKey;
  readonly sell: EvmToken;
  readonly buy: EvmToken;
  readonly request: EvmQuoteRequest;
  readonly usdValue: number | null;
}

/**
 * `owner` is the wallet a swap naming no amount sells from (see `wholeSale` for
 * how much), null while there is none to hold anything; `taker` is who the
 * route is built for. `mustHold` refuses a swap selling more than the wallet holds.
 */
async function plan(
  swap: EvmSwapInput,
  owner: () => Promise<string | null>,
  options: EvmSwapOptions & { readonly mustHold?: boolean },
  taker?: string,
): Promise<SwapPlan> {
  const sellsAll = swap.sellAmount === undefined && swap.amountUsd === undefined;
  if (swap.sellAmount !== undefined && swap.amountUsd !== undefined) {
    throw new Error("Pass one of sellAmount or amountUsd, or neither to sell all of it.");
  }
  const priced = (token: EvmToken): EvmToken =>
    options.stockUsd && !isEvmUsdc(swap.chain, token.address)
      ? { ...token, usdPrice: options.stockUsd }
      : token;
  const [sell, buy] = await Promise.all([
    resolveEvmToken(swap.chain, swap.sellToken).then(priced),
    resolveEvmToken(swap.chain, swap.buyToken).then(priced),
  ]);
  if (sell.address === buy.address) throw new Error("sellToken and buyToken are the same token.");
  // The coin a chain keeps in the wallet is never for sale.
  const reserve = sell.address === EVM_NATIVE ? RESERVES[swap.chain] : undefined;
  const holder = sellsAll || reserve || options.mustHold ? await owner() : null;
  const held = holder ? await evmBalance(swap.chain, sell.address, getAddress(holder)) : 0n;
  const spendable = reserve === undefined ? held : held > reserve ? held - reserve : 0n;
  const reserved = () =>
    new Error(
      `${NETWORKS[swap.chain].name} keeps ${unitsLabel(reserve ?? 0n, sell.decimals)} ${sell.symbol} ` +
        `in the wallet as a reserve that can't be sold, so ` +
        `${spendable > 0n ? `only ${unitsLabel(spendable, sell.decimals)}` : "none"} ` +
        `of its ${unitsLabel(held, sell.decimals)} ${sell.symbol} can be.`,
    );
  // Selling all of it sells the exact balance, since a decimal amount read back
  // into base units can land a crumb short of it.
  let sellAmount: bigint;
  if (sellsAll) {
    sellAmount = spendable;
    if (sellAmount === 0n && spendable === 0n && held > 0n) throw reserved();
    if (sellAmount === 0n)
      throw new Error(`No ${sell.symbol} on ${NETWORKS[swap.chain].name} to sell.`);
  } else if (swap.sellAmount !== undefined) {
    sellAmount = toBaseUnits(swap.sellAmount, sell.decimals);
  } else {
    if (!sell.usdPrice)
      throw new Error(`No dollar price for ${sell.symbol}; size the swap with sellAmount instead.`);
    sellAmount = toBaseUnits((swap.amountUsd ?? 0) / sell.usdPrice, sell.decimals);
  }
  if (reserve && sellAmount > spendable) throw reserved();
  // A holding sold by the amount the portfolio shows, or by what a buy logged,
  // can be a crumb more than the wallet holds, so within 1% it sells the
  // balance. Cash is spent exactly.
  if (options.mustHold && sellAmount > held) {
    if (isEvmUsdc(swap.chain, sell.address) || sellAmount > (held * 101n) / 100n)
      throw new Error(
        `Only ${unitsLabel(held, sell.decimals)} ${sell.symbol} on ${NETWORKS[swap.chain].name}, ` +
          `${unitsLabel(sellAmount, sell.decimals)} needed.`,
      );
    sellAmount = held;
  }
  const usdValue =
    swap.amountUsd ??
    (sell.usdPrice ? fromBaseUnits(sellAmount, sell.decimals) * sell.usdPrice : null);
  return {
    chain: swap.chain,
    sell,
    buy,
    usdValue,
    request: {
      chain: swap.chain,
      sellToken: sell.address,
      buyToken: buy.address,
      sellAmount,
      slippageBps: swap.slippageBps ?? 100,
      ...(taker ? { taker: getAddress(taker) } : {}),
    },
  };
}

const unitsLabel = (amount: bigint, decimals: number) =>
  formatAmount(fromBaseUnits(amount, decimals));

/** Dollar size from whichever side has a price, so every swap has one. */
function swapValueUsd(swap: SwapPlan, route: EvmRoute): number {
  if (swap.usdValue !== null) return swap.usdValue;
  if (swap.buy.usdPrice)
    return fromBaseUnits(route.buyAmount, swap.buy.decimals) * swap.buy.usdPrice;
  throw new Error(
    `Neither ${swap.sell.symbol} nor ${swap.buy.symbol} has a dollar price; swap through USDC instead.`,
  );
}

/**
 * How much of a swap's dollars it loses the moment it fills, in percent,
 * valued at both tokens' market prices rather than the route's own quote: a
 * buy into a thin market, or a sale into one, which a specialist makes
 * without asking. Null when a side has no price; a thin or seeded pool quotes
 * its own loss.
 */
function lostPct(swap: SwapPlan, route: EvmRoute): number | null {
  if (!swap.buy.usdPrice || !swap.usdValue) return null;
  const received = fromBaseUnits(route.buyAmount, swap.buy.decimals) * swap.buy.usdPrice;
  return (1 - received / swap.usdValue) * 100;
}

/**
 * `stock` names the tokenized stock a stock trade on Monad buys or sells, for its own card, and
 * `called` what the token a trade for cash buys or sells is called (see tokenCalled), which its
 * card says; `limit` is how much it may lose the moment it fills before a specialist won't make
 * it alone. Its effect is what Auni asks the route for: the sale out of the wallet, and at least
 * the route's least back into it, which execute's simulation of the route's bytes holds it to.
 */
function preview(
  swap: SwapPlan,
  route: EvmRoute,
  limit: number,
  called: string | null,
  stock?: XStock,
): ActionPreview {
  const sold = unitsLabel(swap.request.sellAmount, swap.sell.decimals);
  const bought = unitsLabel(route.buyAmount, swap.buy.decimals);
  const minimum = `${unitsLabel(route.minBuyAmount, swap.buy.decimals)} ${swap.buy.symbol}`;
  const value = swapValueUsd(swap, route);
  const paysCash = isEvmUsdc(swap.chain, swap.sell.address);
  const sellsForCash = isEvmUsdc(swap.chain, swap.buy.address);
  const lost = lostPct(swap, route);
  const traded = sellsForCash ? swap.sell : swap.buy;
  // What it loses to the market, at the bought token's price.
  const impact = swap.buy.usdPrice
    ? value - fromBaseUnits(route.buyAmount, swap.buy.decimals) * swap.buy.usdPrice
    : null;
  const costs = tradeCosts(impact);
  // A tokenized stock on Monad, or a token bought or sold for cash, reads as a trade; one
  // holding for another is said by the plain face.
  const asStock = stock && swap.chain === "monad" ? stock : undefined;
  const trade: TradeTerms | null =
    asStock || paysCash || sellsForCash
      ? {
          side: sellsForCash ? "sell" : "buy",
          symbol: asStock?.symbol ?? traded.symbol,
          stock: asStock ? { company: stockName(asStock), ticker: asStock.ticker } : null,
          name: asStock ? null : called,
          chain: NETWORKS[swap.chain].name,
          receive: sellsForCash ? null : bought,
          selling: sellsForCash ? `${sold} ${swap.sell.symbol}` : null,
          atLeast: sellsForCash ? minimum : null,
          price: traded.usdPrice ? priceLabel(traded.usdPrice) : null,
          costs,
          through: route.provider,
        }
      : null;
  const made: ActionPreview = {
    ...(!sellsForCash && swap.buy.usdPrice === null
      ? { unpriced: "no price" as const }
      : lost !== null && lost > limit
        ? { unpriced: "loses on fill" as const }
        : {}),
    // A buy for cash says what it buys, by what it is called; anything else what it swaps.
    summary:
      paysCash && !asStock
        ? `Buy about ${usdLabel(value)} of ${called ? `${called} (${swap.buy.symbol})` : swap.buy.symbol} on ${NETWORKS[swap.chain].name}`
        : `Swap ${sold} ${swap.sell.symbol} (about ${usdLabel(value)}) for about ${bought} ${swap.buy.symbol} on ${NETWORKS[swap.chain].viem.name}`,
    // Only USDC paid in is cash spent; one holding for another spends none.
    amountUsd: paysCash ? usd(value) : "0",
    effect: {
      gives: [
        paysCash
          ? { text: `${usdLabel(value)} of USDC` }
          : { text: `${sold} ${swap.sell.symbol}`, ...(swap.usdValue ? { usd: value } : {}) },
      ],
      gets: [{ text: `about ${bought} ${swap.buy.symbol}, at least ${minimum}` }],
      grants: [],
      costs,
    },
    details: {
      chain: swap.chain,
      sellToken: swap.sell.address,
      buyToken: swap.buy.address,
      // What the swap is about, so its card wears that token's logo.
      mint: traded.address,
      token: traded.symbol,
      venue: route.provider,
      sell: `${sold} ${swap.sell.symbol}`,
      estimatedReceive: `${bought} ${swap.buy.symbol}`,
      minimumReceive: minimum,
      through: throughOf(route),
      // The least the card says it gets, which execute's transaction holds (see quoteHoldingProceeds).
      [APPROVED_PROCEEDS]: formatUnits(route.minBuyAmount, swap.buy.decimals),
      // What the route pays out.
      ...(sellsForCash
        ? { returnsUsd: usd(fromBaseUnits(route.buyAmount, swap.buy.decimals)) }
        : {}),
    },
    // Built only as it sends, by whichever route quotes best then; the chain is all that's known.
    sends: { chainId: NETWORKS[swap.chain].viem.id },
    // Any holding it gives up, for cash or another token, caps what execute
    // sells, so tokens arriving after the tap are never swept in with it.
    ...(!isEvmUsdc(swap.chain, swap.sell.address)
      ? {
          sells: {
            ...evmTokenKey(swap.chain, swap.sell.address),
            quantity: formatUnits(swap.request.sellAmount, swap.sell.decimals),
          },
        }
      : {}),
  };
  return trade ? withFace(made, (said) => tradeFace(trade, said)) : made;
}

/**
 * `mustHold` refuses a sale the wallet doesn't hold, so a caller can try the
 * token elsewhere. A swap that loses more than `maxLossPct`
 * (MAX_BUY_IMPACT_PCT by default) the moment it fills never runs without a tap.
 */
export async function previewEvmSwap(
  swap: EvmSwapInput,
  owner: () => Promise<string | null>,
  options: EvmSwapOptions & {
    readonly stock?: XStock;
    readonly mustHold?: boolean;
    readonly maxLossPct?: number;
  } = {},
): Promise<ActionPreview> {
  const planned = await plan(swap, owner, options);
  const traded = isEvmUsdc(planned.chain, planned.buy.address) ? planned.sell : planned.buy;
  const [route, called] = await Promise.all([
    (options.quote ?? quoteSwap)(planned.request),
    // A stock reads as its company; any other token as what its list calls it.
    options.stock ? null : tokenCalled(evmTokenKey(planned.chain, traded.address)),
  ]);
  return preview(planned, route, options.maxLossPct ?? MAX_BUY_IMPACT_PCT, called, options.stock);
}

/**
 * Pass execute the options its preview had, so it is quoted and priced the same way; `stock`
 * names the tokenized stock it trades, so what it got reads as shares.
 */
export async function executeEvmSwap(
  swap: EvmSwapInput,
  wallets: Signer,
  approved: Approved,
  options: EvmSwapOptions & { readonly stock?: XStock } = {},
): Promise<ExecuteResult> {
  const pinned = {
    ...swap,
    sellToken: pinnedToken(approved, "sellToken"),
    buyToken: pinnedToken(approved, "buyToken"),
  };
  const planned = await plan(
    pinned,
    async () => wallets.evmAddress,
    { ...options, mustHold: true },
    wallets.evmAddress,
  );
  if (isEvmUsdc(planned.chain, planned.sell.address))
    assertApprovedSpend(approved, planned.request.sellAmount, planned.request.slippageBps);
  assertApprovedSale(approved, planned.request.sellAmount, planned.sell.decimals);
  // The market may have moved since the card, but what the swap lets land never falls under the
  // least it said it gets.
  const quote = options.quote ?? quoteSwap;
  const route = await quoteHoldingProceeds(
    approved,
    planned.buy.decimals,
    planned.request.slippageBps,
    (slippageBps) => quote({ ...planned.request, slippageBps }),
    (fresh) => ({ expected: fresh.buyAmount, least: fresh.minBuyAmount }),
  );
  if (!route.send) throw new Error(`${route.provider} gave no route to send.`);
  // What the swap really paid out, not what the quote promised: the input is exact, the output isn't.
  const { txs, received, note, makerPaid, sold: soldUnits } = await route.send(wallets);
  const sellAmount = soldUnits ?? planned.request.sellAmount;
  if (received <= 0n) {
    // A venue that knows nothing filled says why; otherwise money may have gone, so a person looks.
    if (note) throw new NothingMoved(note);
    throw new Error(`The swap ${txs.at(-1)?.hash} landed but nothing arrived.`);
  }
  return {
    txs,
    fills: swapFills(planned, sellAmount, received, () => swapValueUsd(planned, route)),
    // The venue that ran, which may not be the one the card showed, and what a maker paid
    // (see arrivals.ts).
    run: {
      venue: route.provider,
      through: throughOf(route),
      // What arrived and how, which the card's receipt says in place of what the quote expected.
      filled: `Got ${unitsLabel(received, planned.buy.decimals)} ${
        options.stock && !isEvmUsdc(planned.chain, planned.buy.address)
          ? "shares"
          : planned.buy.symbol
      } through ${throughOf(route)}`,
      ...(makerPaid ? { landsUnits: String(received) } : {}),
    },
    ...(note ? { note } : {}),
  };
}

/**
 * A swap's fills from what it sold and what the wallet received, in base units. Dollars come
 * from the USDC side when there is one; one holding for another is `priced`. USDC is cash, not
 * a holding, so only the other side is a fill; one holding for another leaves the first and
 * enters the second.
 */
function swapFills(
  { chain, sell, buy }: Pick<SwapPlan, "chain" | "sell" | "buy">,
  sellAmount: bigint,
  received: bigint,
  priced: () => number,
): Fill[] {
  const usdValue = isEvmUsdc(chain, sell.address)
    ? formatUnits(sellAmount, 6)
    : isEvmUsdc(chain, buy.address)
      ? formatUnits(received, 6)
      : usd(priced());
  const sold: Fill = {
    ...evmTokenKey(chain, sell.address),
    side: "sell",
    quantity: formatUnits(sellAmount, sell.decimals),
    usdValue,
  };
  const bought: Fill = {
    ...evmTokenKey(chain, buy.address),
    side: "buy",
    quantity: formatUnits(received, buy.decimals),
    usdValue,
  };
  return isEvmUsdc(chain, buy.address)
    ? [sold]
    : isEvmUsdc(chain, sell.address)
      ? [bought]
      : [sold, bought];
}

/**
 * What a swap whose run stopped after sending traded, read back from the receipts of everything
 * it sent (see Recipe.readBack): what the wallet let go of the token its card pinned as sold,
 * and what it received of the one pinned as bought, whichever venue ran. A venue's own sweep or
 * refund is among its sends, so what came back counts. The chain's coin leaves no log: a sale of
 * it sold what its card approved, which execute sells exactly, and a buy of it got what the
 * sends' call traces paid, so a read with no trace to read can't tell (see coinMovedBy).
 *
 * Null while nothing of what it buys has reached the wallet though what it sold is gone: a
 * maker may yet pay from a transaction of its own, or a venue still holds it, and the receipts
 * can't say which. "nothing moved" when all it sold came back.
 */
export async function readBackEvmSwap(
  action: Pick<ActionRow, "details" | "txs">,
  evmAddress: string | null,
): Promise<ReadBack | null> {
  const { sellToken, buyToken } = action.details;
  const chain = action.details.chain as EvmCashKey;
  if (!evmAddress || !sellToken || !buyToken) return null;
  const receipts = await confirmedReceipts(chain, action.txs);
  if (receipts.length === 0) return null;
  const owner = getAddress(evmAddress);
  const [sell, buy] = await Promise.all([
    resolveEvmToken(chain, sellToken),
    resolveEvmToken(chain, buyToken),
  ]);
  const received =
    buy.address === EVM_NATIVE
      ? (await coinMovedBy(chain, receipts, owner))?.in
      : (
          await Promise.all(
            receipts.map((receipt) => receivedBy(chain, receipt, buy.address, owner)),
          )
        ).reduce((sum, amount) => sum + amount, 0n);
  if (received === undefined) return null;
  const approvedSale = action.details[APPROVED_SALE];
  const sold =
    sell.address === EVM_NATIVE
      ? approvedSale === undefined
        ? null
        : parseUnits(approvedSale, sell.decimals)
      : receipts
          .map(({ logs }) => walletEffect(logs, owner))
          .reduce(
            (sum, effect) =>
              sum + unitsOf(effect.out, sell.address) - unitsOf(effect.in, sell.address),
            0n,
          );
  if (sold === null) return null;
  if (received <= 0n) return sold <= 0n ? "nothing moved" : null;
  const fills = swapFills({ chain, sell, buy }, sold, received, () => {
    const [token, units] = sell.usdPrice ? [sell, sold] : [buy, received];
    if (!token.usdPrice) throw new Error(`Neither ${sell.symbol} nor ${buy.symbol} has a price.`);
    return fromBaseUnits(units, token.decimals) * token.usdPrice;
  });
  return { fills };
}

const unitsOf = (legs: readonly { token: string; amount: bigint }[], token: string) =>
  legs.find((leg) => leg.token.toLowerCase() === token.toLowerCase())?.amount ?? 0n;

export const evmSwap: Recipe<typeof input> = {
  tool: "evm_swap",
  description:
    "Swap tokens on Monad, Base, Arbitrum, or Polygon at the best quote of every route that swaps any pair. " +
    "Handles token approval. Size by sellAmount or amountUsd, or neither to sell all of sellToken. " +
    "Prefer stock_trade for tokenized stocks.",
  input,
  venue: "evm-swap",
  mark: "swap",
  describe: (swap) => previewEvmSwap(swap, evmAddress),
  // From USDC it buys, into USDC it sells; one holding for another asks.
  direction: (swap) =>
    isEvmUsdc(swap.chain, swap.sellToken)
      ? "buy"
      : isEvmUsdc(swap.chain, swap.buyToken)
        ? "sell"
        : null,
  fundedFrom: ({ input: swap }) => (isEvmUsdc(swap.chain, swap.sellToken) ? swap.chain : null),
  about: ({ input: swap, details, amountUsd }) =>
    tradedToken(details, isEvmUsdc(swap.chain, swap.sellToken) ? Number(amountUsd) : 0),
  execute: ({ input: swap, wallets, action }) => executeEvmSwap(swap, wallets, action),
  readBack: ({ action, evmAddress }) => readBackEvmSwap(action, evmAddress),
};
