import { z } from "zod";

import type { Approved } from "../approved.ts";
import {
  tradedToken,
  type ActionPreview,
  type ExecuteResult,
  type Recipe,
  type Signer,
} from "../recipe.ts";
import { dollars } from "../summaries.ts";
import { evmAddress, noAddressOn, solanaAddress } from "../wallets.ts";
import {
  executeEvmSwap,
  readBackEvmSwap,
  previewEvmSwap,
  type EvmSwapInput,
  type EvmSwapOptions,
} from "../swaps/evm-swap.ts";
import { filling } from "../../apps/registry.ts";
import { quoteStock } from "../swaps/routes.ts";
import { findXStock, marketNote, type XStock } from "../swaps/xstocks.ts";
import {
  executeSolanaSwap,
  readBackSolanaSwap,
  previewSolanaSwap,
  solanaPrice,
  type SolanaSwapInput,
} from "../swaps/solana-swap.ts";

const input = {
  stock: z.string().min(1).describe("Ticker (NVDA), xStock symbol (NVDAx), or company name."),
  side: z.enum(["buy", "sell"]),
  amountUsd: z
    .number()
    .positive()
    .optional()
    .describe("Dollars to spend on a buy, or to raise on a sell."),
  shares: z
    .number()
    .positive()
    .optional()
    .describe(
      "Shares to buy or sell, as the portfolio shows them. Leave this and amountUsd out to sell every share held.",
    ),
  chain: z
    .enum(["monad", "solana"])
    .optional()
    .describe(
      "Leave empty to prefer Monad when the stock trades there. For sells, pass the chain holding the shares.",
    ),
  slippageBps: z.number().int().min(10).max(500).optional().describe("Defaults to 100 (1%)."),
};

type StockTradeInput = z.infer<z.ZodObject<typeof input>>;

// The most a normal stock trade loses to fill, at the share's price: a $25
// buy on Monad lost -2% to 0.6% in October 2026, with the US market closed. One that loses more
// says what it costs on its card, and no specialist makes it on its own.
const MAX_STOCK_LOSS_PCT = 2;

function solanaInput(stock: XStock, trade: StockTradeInput): SolanaSwapInput {
  if (!stock.solanaMint) throw new Error(`${stock.symbol} has no Solana token.`);
  return {
    token: stock.solanaMint,
    side: trade.side,
    ...(trade.amountUsd !== undefined ? { amountUsd: trade.amountUsd } : {}),
    ...(trade.shares !== undefined ? { tokenAmount: trade.shares } : {}),
    ...(trade.slippageBps !== undefined ? { slippageBps: trade.slippageBps } : {}),
  };
}

/**
 * A share's dollar price for Monad, which has no feed of its own for xStocks
 * yet: the Solana twin prices the same share, and a Monad token is one share
 * as the wallet shows it. Null when there is no twin or the Solana route can't price
 * it, which leaves a buy unpriced, so it asks.
 */
async function twinPrice(stock: XStock): Promise<number | null> {
  if (!stock.solanaMint) return null;
  return solanaPrice(stock.solanaMint).then(
    (price) => price.usdPrice,
    () => null,
  );
}

function monadInput(stock: XStock, trade: StockTradeInput, price: number | null): EvmSwapInput {
  const token = stock.evmAddress;
  if (!token) throw new Error(`${stock.symbol} has no Monad token.`);
  const sharePrice = () => {
    if (!price)
      throw new Error(
        `No price for ${stock.symbol} to size it by; size it on Monad in ${trade.side === "buy" ? "dollars" : "shares"}.`,
      );
    return price;
  };
  const slippage = trade.slippageBps !== undefined ? { slippageBps: trade.slippageBps } : {};
  if (trade.side === "buy") {
    const amountUsd = trade.amountUsd ?? (trade.shares ?? 0) * sharePrice();
    return {
      chain: "monad",
      sellToken: "USDC",
      buyToken: token,
      sellAmount: amountUsd,
      ...slippage,
    };
  }
  // A sell naming neither sells every share held.
  const shares =
    trade.shares ?? (trade.amountUsd !== undefined ? trade.amountUsd / sharePrice() : undefined);
  return {
    chain: "monad",
    sellToken: token,
    buyToken: "USDC",
    ...(shares !== undefined ? { sellAmount: shares } : {}),
    ...slippage,
  };
}

/** How a Monad stock trade is quoted and priced, the same at preview and at execute. */
function onMonad(price: number | null): EvmSwapOptions {
  return { quote: quoteStock, stockUsd: price };
}

/** A stock trade's preview on Monad, as its card and find_instruments both judge it. */
async function previewOnMonad(
  stock: XStock,
  trade: StockTradeInput,
  owner: () => Promise<string | null>,
): Promise<ActionPreview> {
  const price = await twinPrice(stock);
  return previewEvmSwap(monadInput(stock, trade, price), owner, {
    ...onMonad(price),
    maxLossPct: MAX_STOCK_LOSS_PCT,
    stock,
    // Shares named for a sale may be held on Solana; then they sell there.
    mustHold: trade.side === "sell" && trade.chain === undefined,
  });
}

/**
 * What `amountUsd` of `stock` costs to buy on Monad right now, judged as its card would be, with
 * no wallet needed: for find_instruments, so the agent picks knowing. Throws what Monad answered
 * when none of its venues can sell it.
 */
export function previewMonadBuy(stock: XStock, amountUsd: number): Promise<ActionPreview> {
  return previewOnMonad(stock, { stock: stock.symbol, side: "buy", amountUsd }, async () => null);
}

function checkSize(trade: StockTradeInput): void {
  const sellsAll =
    trade.side === "sell" && trade.amountUsd === undefined && trade.shares === undefined;
  if (!sellsAll && (trade.amountUsd === undefined) === (trade.shares === undefined)) {
    throw new Error("Pass exactly one of amountUsd or shares, or neither to sell every share.");
  }
}

/**
 * On Monad whenever it has a seller, at whatever that costs, which its card says; unless the
 * trade is pinned to Solana. Only a stock no Monad venue can trade moves to Solana, with a note
 * saying what Monad answered, so the agent can judge that path; a trade pinned to Monad gets that
 * answer as its error instead.
 */
async function describeTrade(trade: StockTradeInput): Promise<ActionPreview> {
  checkSize(trade);
  const stock = await findXStock(trade.stock);
  const onSolana = () =>
    previewSolanaSwap(solanaInput(stock, trade), {
      maxLossPct: MAX_STOCK_LOSS_PCT,
      stock,
      owner: solanaAddress,
    });
  if (trade.chain === "solana") return stockCard(stock, trade, "solana", await onSolana());

  const monad = await previewOnMonad(stock, trade, evmAddress).catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  if (typeof monad !== "string") return stockCard(stock, trade, "monad", monad);
  const reason = monad + (await marketNote(stock));
  if (trade.chain === "monad")
    throw new Error(`${stock.symbol} can't trade on Monad now: ${reason}`);
  const solana = await onSolana().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} On Monad: ${reason}`);
  });
  return stockCard(
    stock,
    trade,
    "solana",
    solana,
    `On Monad: ${reason} So this trades on Solana with USDC there.`,
  );
}

/** The card for a stock trade on `chain`, from the swap preview there; `note` says why it isn't on Monad. */
function stockCard(
  stock: XStock,
  trade: StockTradeInput,
  chain: "monad" | "solana",
  inner: ActionPreview,
  note?: string,
): ActionPreview {
  const where = chain === "monad" ? "Monad" : "Solana";
  const summary =
    trade.side === "buy"
      ? `Buy about ${dollars(inner.amountUsd)} of ${stock.name} on ${where}`
      : `Sell about ${dollars(inner.details?.returnsUsd ?? "0")} of ${stock.name} on ${where}`;
  // The swap's card whole, its own face too (a trade reads the same whichever chain it settles
  // on), and all core reads of it as the card is prepared: what it sends, and the SOL it buys
  // (ActionPreview.buysSol), which a card buys once.
  return {
    ...inner,
    summary,
    details: { ...inner.details, stock: stock.symbol, chain, ...(note ? { note } : {}) },
  };
}

/** Runs on the chain the owner approved, even if Monad opened up in between. */
async function executeTrade(
  trade: StockTradeInput,
  wallets: Signer,
  approved: Approved,
): Promise<ExecuteResult> {
  checkSize(trade);
  const stock = await findXStock(trade.stock);
  if (approved.details.chain !== "monad")
    return executeSolanaSwap(solanaInput(stock, trade), wallets, approved);
  const price = await twinPrice(stock);
  return executeEvmSwap(monadInput(stock, trade, price), wallets, approved, {
    ...onMonad(price),
    stock,
  });
}

export const stockTrade: Recipe<typeof input> = {
  tool: "stock_trade",
  // Read when the tools are listed, once every route has loaded.
  description: ({ solana }) => {
    const booked = filling("swaps").filter(({ part }) => part.books?.length);
    const books = booked.flatMap(({ part }) => part.books ?? []);
    const owners = booked.map(({ about }) => `${about.name}'s`).join(" and ");
    return (
      "Buy or sell a tokenized stock or ETF (xStocks: NVDA, TSLA, AAPL, SPY, GLD and ~1,100 more). " +
      "Trades prefer Monad, where the owner's USDC rests: Auni quotes every Monad venue and takes the best, " +
      `so you never choose venues. There, ${books.map((symbol) => symbol.replace(/x$/u, "")).join(", ")} ` +
      `trade at any size on ${owners} order books, and every other stock fills from $10, the least its market ` +
      `makers take, so ${solana ? "where a plan allows, size those at $10 or more to keep them off a bridge" : "size those at $10 or more"}. The preview ` +
      "decides where a trade goes and its result says why, so tell the owner that rather than predicting it. " +
      (solana
        ? "Only a stock no Monad venue can trade moves to Solana, through the best Solana route with USDC on Solana " +
          "(short there, one propose_actions card brings the cash and buys, on one tap): its note says what Monad answered and, when known, when the stock's " +
          "market reopens, and its costs say what it loses to fill there, where many stocks barely trade. " +
          "Judge from those what helps most: the Solana trade, waiting for the market (a watch can wake " +
          "you), or another stock. "
        : `A trade no Monad venue takes has no other route for this wallet: ${noAddressOn("Solana")} Its error says what Monad answered and, when known, when the stock's market reopens: offer a size Monad takes, waiting for the market (a watch can wake you), or another stock. `) +
      "Pinned to Monad, the error carries the same answer. Some Monad venues fill an " +
      "order a market maker takes; one it won't take fails with nothing traded and the money still in the wallet, " +
      "most often while the stock moves fast. Then offer it again on Monad in a few minutes, as a fresh card" +
      (solana ? ", and Solana only if it keeps failing or they want it now." : ".")
    );
  },
  input,
  venue: "xstocks",
  mark: "stocks",
  // A Monad trade sets an exact allowance and reads what it got from the wallet's balance, which
  // another at the same time would upset.
  lane: ({ details }) => (details.chain === "monad" ? "monad-stocks" : null),
  describe: (trade) => describeTrade(trade),
  direction: (trade) => trade.side,
  fundedFrom: ({ input: trade, details }) =>
    trade.side === "buy" && (details.chain === "monad" || details.chain === "solana")
      ? details.chain
      : null,
  about: ({ input: trade, details, amountUsd }) =>
    tradedToken(details, trade.side === "buy" ? Number(amountUsd) : 0),
  execute: ({ input: trade, wallets, action }) => executeTrade(trade, wallets, action),
  // Read back as the swap it ran as, on the chain its card was approved for.
  readBack: ({ action, input: trade, evmAddress, solanaAddress }) =>
    action.details.chain === "monad"
      ? readBackEvmSwap(action, evmAddress)
      : readBackSolanaSwap(action, trade.side, solanaAddress),
};
