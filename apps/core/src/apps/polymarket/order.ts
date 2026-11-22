import { setTimeout as sleep } from "node:timers/promises";

import { getAddress, type Address } from "viem";
import { z } from "zod";

import type { ActionRow } from "../../db/schema.ts";
import {
  APPROVED_PRICE_AT_LEAST,
  APPROVED_PRICE_AT_MOST,
  approvedPrice,
  assertApprovedSale,
  assertApprovedSpend,
} from "../../money/approved.ts";
import { LINES, type Grant } from "../../money/effect.ts";
import { formatAmount, usdLabel } from "../../money/format.ts";
import type { ExecuteResult, Fill, Recipe, SentTx } from "../../money/recipe.ts";
import { centsToUsd } from "../../money/usd.ts";
import { evmAddress } from "../../money/wallets.ts";
import {
  apiCredentials,
  feeTerms,
  type Book,
  orderBook,
  orderStatus,
  postOrder,
  refreshBalances,
  tradeHashes,
  type PlacedOrder,
} from "./clob.ts";
import about from "./about.ts";
import { cents, orderFace } from "./card.ts";
import { outcomeKey } from "./keys.ts";
import { resolveOutcome } from "./markets.ts";
import {
  buyFeeCeiling,
  microsText,
  newOrder,
  orderBody,
  orderFee,
  orderTypedData,
  priceOnTick,
  priceToFill,
  SCALE,
  sizeMarket,
  toMicros,
  wrapOrderSignature,
  type FeeTerms,
  type OrderMessage,
  type Sized,
} from "./orders.ts";
import { signTyped } from "../../money/typed-data.ts";
import { ensureDeployed, runBatch } from "./relayer.ts";
import {
  autoRedeemCalls,
  depositWallet,
  fundBuy,
  pusdApprovalCalls,
  heldShares,
  shareApprovalCalls,
  type Call,
  type Funding,
} from "./wallet.ts";

// Polymarket refuses a buy under $1 ("invalid amount for a marketable BUY order"); a sale
// has no such floor.
const MINIMUM_MARKET_BUY = 1_000_000n;

const input = {
  market: z
    .string()
    .min(1)
    .describe("Condition id or slug from polymarket_markets, or an outcome token id."),
  outcome: z
    .string()
    .optional()
    .describe('Outcome to trade, e.g. "Yes" or "No". Not needed with a token id.'),
  side: z.enum(["buy", "sell"]),
  amountUsd: z
    .number()
    .positive()
    .optional()
    .describe("Buy: dollars to spend; fees come on top. Sell: dollars of shares to sell."),
  shares: z
    .number()
    .positive()
    .optional()
    .describe("Sell only: exact shares to sell. Omit this and amountUsd to sell everything."),
};

type Order = z.infer<z.ZodObject<typeof input>>;

export const polymarketOrder: Recipe<typeof input> = {
  tool: "polymarket_order",
  description:
    "Buy or sell shares of a Polymarket outcome with USD. It fills now against the book and any part the book can't fill is cancelled, so nothing is left resting on it; to trade at a price, watch the outcome's price and order when it gets there. Polymarket's own fee is charged on top of a buy. Polymarket refuses a buy under $1; a sale can be any size. The owner's Polymarket moves run one at a time, so several queue rather than fail; to close several positions together, put them on one card with propose_actions. Once a market resolves, Polymarket pays its winning shares out into the owner's Polymarket cash by itself, so there is nothing to sell or collect. What a sale or a payout pays waits in their Polymarket wallet as cash, which pays for their next buy there and which polymarket_withdraw brings back to their own wallet.",
  input,
  venue: "polymarket",
  direction: (order) => order.side,
  // A buy spends Polygon cash: native USDC, or the deposit wallet's pUSD,
  // which funding counts as Polygon cash too.
  fundedFrom: ({ input: order }) => (order.side === "buy" ? "polygon" : null),
  about: ({ input: order, details }) => ({
    kind: "outcome",
    market: order.market,
    outcome: order.outcome,
    buysUsd: order.side === "buy" ? (order.amountUsd ?? 0) : 0,
    image: details.image,
  }),

  async describe(order, { heldTo }) {
    const [market, wallet] = await Promise.all([
      resolveOutcome(order.market, order.outcome),
      evmAddress().then((owner) => (owner ? depositWallet(owner) : null)),
    ]);
    const book = await orderBook(market.tokenId);
    const best = order.side === "buy" ? book.asks.at(-1)?.price : book.bids.at(-1)?.price;
    const price = Number(best ?? "0");
    const selling =
      order.side === "sell"
        ? await sharesToSell(order, price, () =>
            heldShares(wallet, market.protocol.shares, market.tokenId),
          )
        : null;
    const shares =
      selling !== null
        ? formatAmount(Number(microsText(selling)))
        : order.amountUsd !== undefined && price > 0
          ? formatAmount(order.amountUsd / price)
          : null;
    // Fees come on top of a buy, so the most it can spend is what a pot budgets.
    const spend = order.side === "buy" ? toMicros(order.amountUsd ?? 0) : 0n;
    const withFees =
      spend > 0n
        ? spend +
          buyFeeCeiling(
            spend,
            price > 0 ? (spend * SCALE) / toMicros(price) : 0n,
            await feeTerms(market.conditionId),
          )
        : 0n;
    // Sized as execute will send it, so a card Polymarket would refuse is never offered.
    const sized = sizeOrder(order, market, book, selling, heldTo);
    // A sale gets back at least the cash it asks for, less Polymarket's fee.
    const sale = selling !== null ? sized : null;
    const returns =
      sale &&
      sale.takerAmount -
        orderFee(sale.takerAmount, sale.makerAmount, await feeTerms(market.conditionId));
    const isBuy = order.side === "buy";
    const { grants } = await setup(wallet?.address ?? null, market, isBuy, withFees);
    const lands = "in your Polymarket wallet";
    const usdOf = (micros: bigint) => Number(microsText(micros));
    const words = {
      side: order.side,
      question: market.question,
      outcome: market.outcome,
      price: price > 0 ? price : null,
      shares,
      worst: Number(microsText(sized.price)),
    };
    return {
      summary: isBuy
        ? `Buy ${usdLabel(order.amountUsd ?? 0)} of ${market.outcome} on "${market.question}"`
        : `Sell ${order.shares !== undefined ? formatAmount(order.shares) : order.amountUsd === undefined ? `all ${shares}` : `${usdLabel(order.amountUsd)} of`} ${market.outcome} shares on "${market.question}"`,
      amountUsd: microsText(withFees),
      // Orders and batches Auni's code builds against Polymarket's fixed contracts; what it
      // gets lands in the owner's own deposit wallet.
      effect: {
        gives: [
          isBuy
            ? { text: `up to ${usdLabel(usdOf(withFees))} of Polygon cash` }
            : { text: `${shares ?? "your"} ${market.outcome} shares` },
        ],
        gets: [
          isBuy
            ? { text: `about ${shares ?? "some"} ${market.outcome} shares`, lands }
            : returns && returns > 0n
              ? { text: `at least ${usdLabel(usdOf(returns))}`, lands }
              : { text: "cash for them", lands },
        ],
        grants,
        costs: [
          ...(spend > 0n ? [{ label: "in fees, at most", usd: usdOf(withFees - spend) }] : []),
          ...(sale && returns !== null
            ? [{ label: "in fees", usd: usdOf(sale.takerAmount - returns) }]
            : []),
        ],
      },
      details: {
        // The worst price it fills at, a little past the book now (see withSlack), which
        // execute never goes past (see approvedPrice).
        [isBuy ? APPROVED_PRICE_AT_MOST : APPROVED_PRICE_AT_LEAST]: microsText(sized.price),
        // In whole cents, rounded down.
        ...(returns && returns > 0n ? { returnsUsd: centsToUsd(returns / 10_000n) } : {}),
        // So its card wears the market's picture.
        ...(market.image ? { image: market.image } : {}),
      },
      card: orderFace(words),
      ...(selling !== null
        ? { sells: { ...outcomeKey(market.tokenId), quantity: microsText(selling) } }
        : {}),
    };
  },

  async execute({ input: order, wallets, action, recordSent, posting }) {
    const market = await resolveOutcome(order.market, order.outcome);
    if (!market.acceptingOrders) throw new Error(`"${market.question}" is not accepting orders.`);
    const owner = getAddress(wallets.evmAddress);
    const wallet = await depositWallet(owner);
    const book = await orderBook(market.tokenId);
    const isBuy = order.side === "buy";
    // Every card pins the worst price it fills at, so one that didn't has nothing to hold
    // its order to.
    if (action.details[isBuy ? APPROVED_PRICE_AT_MOST : APPROVED_PRICE_AT_LEAST] === undefined)
      throw new Error("This card doesn't say the worst price it trades at. Nothing was sent.");
    const txs: SentTx[] = [];

    let selling: bigint | null = null;
    if (!isBuy) {
      const held = await heldShares(wallet, market.protocol.shares, market.tokenId);
      const reference = Number(book.bids.at(-1)?.price ?? "0");
      selling = await sharesToSell(order, reference, async () => held);
      if (selling > held)
        throw new Error(
          `The Polymarket wallet holds ${microsText(held)} ${market.outcome} shares, fewer than the ${microsText(selling)} to sell.`,
        );
      assertApprovedSale(action, selling, 6);
    }
    const sized = sizeOrder(order, market, book, selling, action);
    const shares = isBuy ? sized.takerAmount : sized.makerAmount;
    const cash = isBuy ? sized.makerAmount : sized.takerAmount;
    const fees = await feeTerms(market.conditionId);
    const required = cash + buyFeeCeiling(cash, shares, fees);
    if (isBuy) assertApprovedSpend(action, required);

    // Whoever allowed it, by tap or on a specialist's own, saw only the powers its card named.
    const approvals = await setup(wallet.address, market, isBuy, required);
    const shown = action.lines.find(({ label }) => label === LINES.lets)?.value ?? "";
    const unshown = approvals.grants.find(({ lets }) => !shown.includes(lets));
    if (unshown)
      throw new Error(
        `This would now let ${unshown.lets}, which its card didn't show, so nothing was sent.`,
      );
    await ensureDeployed(owner, wallet);
    let funding: Funding = { calls: [] };
    if (isBuy) {
      const funded = await fundBuy(wallets, wallet.address, required);
      funding = funded.funding;
      txs.push(...funded.txs);
    }
    if (funding.calls.length > 0 || approvals.calls.length > 0) {
      const hash = await runBatch(
        wallets,
        wallet.address,
        { calls: approvals.calls, funding, metadata: "auni trading setup", setup: true },
        recordSent,
      );
      txs.push({ chain: "polygon", hash, setup: true });
    }

    const creds = await apiCredentials(wallets);
    await refreshBalances(
      creds,
      isBuy ? undefined : { tokenId: market.tokenId, assetType: market.protocol.assetType },
    );
    const message = newOrder({
      wallet: wallet.address,
      tokenId: market.tokenId,
      side: order.side,
      sized,
    });
    const signature = wrapOrderSignature(
      message,
      market.protocol.exchange,
      await signTyped(wallets, orderTypedData(message, market.protocol.exchange)),
    );
    // Kept as sent with no hash before it is posted, so a run cut off once the book may have
    // taken it is held, never failed; its hashes speak for it once Polymarket names them.
    const placed = await posting("polygon", () =>
      postOrder(creds, orderBody({ order: message, signature, apiKey: creds.apiKey })),
    );
    const hashes =
      placed.transactionHashes.length > 0
        ? placed.transactionHashes
        : await tradeHashes(creds, placed.tradeIds);
    for (const hash of hashes) {
      await recordSent({ chain: "polygon", hash });
      txs.push({ chain: "polygon", hash });
    }
    const filled = await fillOf(placed, message, order, market, fees, () =>
      orderStatus(creds, placed.orderId),
    );
    return {
      txs,
      fills: filled ? [filled.fill] : [],
      ...(filled ? { run: { filled: filled.words } } : {}),
    } satisfies ExecuteResult;
  },
};

/**
 * The approvals a trade still needs on the owner's Polymarket deposit wallet,
 * and the lasting powers they grant, which its card names: a buy lets the
 * market's exchanges trade the wallet's cash and, since every share comes
 * through a buy, Polymarket's AutoRedeemer collect its winnings; a sale lets
 * the exchanges trade its shares. Each reaches only what the owner has put in
 * that wallet, never their main one. None once granted, and all of them for a
 * wallet not owned yet (null).
 */
async function setup(
  wallet: Address | null,
  market: Awaited<ReturnType<typeof resolveOutcome>>,
  isBuy: boolean,
  needed: bigint,
): Promise<{ readonly calls: Call[]; readonly grants: Grant[] }> {
  const { spenders, shares } = market.protocol;
  const grant = (calls: readonly Call[], lets: string): Grant[] =>
    calls.length > 0 ? [{ lets, reach: "venue" }] : [];
  if (isBuy) {
    const [trades, redeems] = await Promise.all([
      pusdApprovalCalls(wallet, spenders, needed),
      autoRedeemCalls(wallet),
    ]);
    return {
      calls: [...trades, ...redeems],
      grants: [
        ...grant(trades, "Polymarket's exchanges trade the cash in your Polymarket wallet"),
        ...grant(redeems, "Polymarket collect your winnings when a market resolves"),
      ],
    };
  }
  const trades = (
    await Promise.all(spenders.map((spender) => shareApprovalCalls(wallet, shares, spender)))
  ).flat();
  return {
    calls: trades,
    grants: grant(trades, "Polymarket's exchanges trade the shares in your Polymarket wallet"),
  };
}

/**
 * The shares a sell asks for, in micros: exact shares, its dollars at the
 * reference price, or everything the wallet holds. Execute sells at most this.
 */
async function sharesToSell(
  order: Order,
  reference: number,
  held: () => Promise<bigint>,
): Promise<bigint> {
  if (order.shares !== undefined) return toMicros(order.shares);
  if (order.amountUsd !== undefined && reference > 0) return toMicros(order.amountUsd / reference);
  const all = await held();
  // Polymarket settles a fill on-chain a little after it matches, so a sale right after a buy
  // can find nothing there yet.
  if (all === 0n)
    throw new Error(
      "The Polymarket wallet holds none of these shares yet. A buy settles on-chain within a minute or so of filling; try the sale again then.",
    );
  return all;
}

/**
 * The order as execute sends it, refused when Polymarket would refuse it: priced
 * deep enough into the book to fill now, so a buy spends its dollars and a sale of
 * `selling` shares asks for the least cash it gets back. Once approved, its price
 * is held to the worst its card was approved at (see approvedPrice), so the order
 * itself fills no worse than its card: refused once the book's best price is past
 * that, and any of it the book can't fill inside it is cancelled.
 */
function sizeOrder(
  order: Order,
  market: { readonly tickMicros: bigint },
  book: Book,
  selling: bigint | null,
  approved: Pick<ActionRow, "details"> = { details: {} },
): Sized & { readonly price: bigint } {
  const spend = selling ?? (order.amountUsd === undefined ? null : toMicros(order.amountUsd));
  if (spend === null) throw new Error("A buy needs amountUsd.");
  const side = selling === null ? "buy" : "sell";
  const levels = side === "buy" ? book.asks : book.bids;
  const fills = priceToFill(levels, Number(microsText(spend)), side);
  // The book lists its best price last.
  const best = Number(levels.at(-1)?.price ?? fills);
  const quoted = microsText(withSlack(toMicros(fills), market.tickMicros, side));
  const price = priceOnTick(
    toMicros(approvedPrice(approved, { mark: best, quoted })),
    market.tickMicros,
    side,
  );
  const sized = { price, ...sizeMarket(side, price, market.tickMicros, spend) };
  if (side === "buy" && sized.makerAmount < MINIMUM_MARKET_BUY)
    throw new Error("Polymarket refuses a buy under $1. Buy at least $1.");
  if ((side === "buy" ? sized.takerAmount : sized.makerAmount) === 0n)
    throw new Error("The amount is too small to buy a single share step at this price.");
  return sized;
}

// How far past the fill a card's worst price sits, as Hyperliquid's market orders allow, so a
// book that ticks between the card and the tap still fills; what the card says it gets back is
// worked out at that worst price.
const PRICE_SLACK_BPS = 100n;

/** `price` moved against `side` by PRICE_SLACK_BPS, out to a whole tick, inside Polymarket's range. */
function withSlack(price: bigint, tickMicros: bigint, side: "buy" | "sell"): bigint {
  const slack = (price * PRICE_SLACK_BPS + 9_999n) / 10_000n;
  const ticks = ((slack + tickMicros - 1n) / tickMicros) * tickMicros;
  const moved = side === "buy" ? price + ticks : price - ticks;
  return moved < tickMicros ? tickMicros : moved > SCALE - tickMicros ? SCALE - tickMicros : moved;
}

/** What an order filled, and the sentence the owner and the agent read of it. */
async function fillOf(
  placed: PlacedOrder,
  message: OrderMessage,
  order: Order,
  market: { readonly tokenId: string | bigint; readonly outcome: string },
  fees: FeeTerms,
  readBack: () => Promise<{ readonly status: string } | null>,
): Promise<{ readonly fill: Fill; readonly words: string } | undefined> {
  let status = placed.status;
  if (status === "delayed") {
    await sleep(3_000);
    status = (await readBack())?.status ?? status;
  }
  if (status !== "matched") return undefined;
  let making = message.makerAmount;
  let taking = message.takerAmount;
  if (placed.makingAmount && placed.takingAmount) {
    // The CLOB has reported matched amounts both as decimals and as base units.
    const decimal =
      placed.makingAmount.includes(".") || toMicros(placed.makingAmount) <= message.makerAmount;
    making = decimal ? toMicros(placed.makingAmount) : BigInt(placed.makingAmount);
    taking = decimal ? toMicros(placed.takingAmount) : BigInt(placed.takingAmount);
  }
  const isBuy = order.side === "buy";
  const shares = isBuy ? taking : making;
  const cash = isBuy ? making : taking;
  // A buy pays its fees on top and a sale pays them from its proceeds, so the pot sees both.
  const fee = orderFee(cash, shares, fees);
  const usdValue = microsText(isBuy ? cash + fee : cash > fee ? cash - fee : 0n);
  const each = shares > 0n ? ` at ${cents(Number(cash) / Number(shares))} each` : "";
  return {
    fill: {
      ...outcomeKey(market.tokenId),
      side: order.side,
      quantity: microsText(shares),
      usdValue,
    },
    words: `${isBuy ? "Bought" : "Sold"} ${formatAmount(Number(microsText(shares)))} ${market.outcome} shares${each}, ${usdLabel(Number(usdValue))} ${isBuy ? "with" : "back after"} ${about.name}'s fee`,
  };
}
