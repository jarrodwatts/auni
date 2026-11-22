import { address } from "@solana/kit";
import { z } from "zod";

import type { ActionRow } from "../../db/schema.ts";
import {
  APPROVED_PROCEEDS,
  assertApprovedSale,
  assertApprovedSpend,
  assertBytesDo,
  pinnedToken,
  quoteHoldingProceeds,
  type Approved,
} from "../approved.ts";
import { costsLabel } from "../effect.ts";
import { solanaMintKey } from "../fill-key.ts";
import {
  tradedToken,
  type ActionPreview,
  type SentTx,
  type SpecialistHolds,
  type ExecuteResult,
  type ReadBack,
  type Recipe,
  type Signer,
} from "../recipe.ts";
import { solForFees, topUpSol, withTopUp, type SolTopUp } from "../sol-top-up.ts";
import { formatUnits } from "../usd.ts";
import { landedEffect, simulateSolana } from "../solana-effect.ts";
import { noAddressOn, paysOwnGas, solanaAddress } from "../wallets.ts";
import { tradeFace, withFace, type TradeTerms } from "../card-face.ts";
import { formatAmount, priceLabel, usdLabel } from "../format.ts";
import {
  fromBaseUnits,
  MAX_BUY_IMPACT_PCT,
  toBaseUnits,
  tradeCosts,
  usd,
  wholeSale,
} from "../swaps/shared.ts";
import type {
  SolanaQuote,
  SolanaQuoteRequest,
  SolanaRoute,
  SolanaToken,
} from "../../apps/contract.ts";
import { filling } from "../../apps/registry.ts";
import { SOLANA_USDC, solanaTokenBalance } from "../chains.ts";
import { stockName } from "./stock-index.ts";
import type { XStock } from "./xstocks.ts";

const input = {
  token: z
    .string()
    .min(1)
    .describe(
      "Symbol (NVDAx, JUP, BONK) or mint address of the Solana token to trade against USDC.",
    ),
  side: z.enum(["buy", "sell"]),
  amountUsd: z
    .number()
    .positive()
    .optional()
    .describe("Dollars to spend on a buy, or to raise on a sell."),
  tokenAmount: z
    .number()
    .positive()
    .optional()
    .describe(
      "Tokens to buy or sell, as the portfolio shows them. To sell everything, leave this and amountUsd out; for a specialist, that is everything it holds.",
    ),
  slippageBps: z.number().int().min(10).max(500).optional().describe("Defaults to 100 (1%)."),
};

export type SolanaSwapInput = z.infer<z.ZodObject<typeof input>>;

/**
 * Solana swaps go through the routes apps provide (see SolanaRoute), as EVM swaps do: each
 * route quotes the trade, the one that gets the most wins, and the card pins it by name
 * (details.venue), so execute builds on the route its card was quoted on. Tokens are searched
 * and priced through the first route.
 */
type NamedRoute = { readonly name: string; readonly route: SolanaRoute };

function routes(): NamedRoute[] {
  const all = filling("solana").map(({ about, part }) => ({ name: about.name, route: part }));
  if (all.length === 0) throw new Error("No app provides a Solana swap route.");
  return all;
}

/** The route searches and prices go through: the first apps/order.ts names. */
function firstRoute(): SolanaRoute {
  return routes()[0]!.route;
}

/** Solana tokens by symbol, name or mint, most relevant first (see SolanaRoute.search). */
export function searchSolanaTokens(text: string): Promise<SolanaToken[]> {
  return firstRoute().search(text);
}

/** These mints' listings, as many as the route lists. */
export function solanaTokens(mints: readonly string[]): Promise<SolanaToken[]> {
  return firstRoute().tokens(mints);
}

/** A token's price now, as Auni values what it holds: an xStock's share's (see SolanaPrice). */
export function solanaPrice(mint: string) {
  return firstRoute().price(mint);
}

const isMint = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value);

/** A mint address, or the most liquid verified token with exactly this symbol. */
async function resolveSolanaToken(tokenOrMint: string): Promise<SolanaToken> {
  const query = tokenOrMint.trim();
  const tokens = await searchSolanaTokens(query);
  const match = isMint(query)
    ? tokens.find((token) => token.mint === query)
    : tokens
        .filter((token) => token.symbol.toLowerCase() === query.toLowerCase() && token.verified)
        .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
  if (!match)
    throw new Error(`No verified Solana token matches "${query}". Pass its mint address.`);
  return match;
}

/**
 * Every route is asked at once, and the one getting the most wins. Throws when none can quote,
 * naming each route's reason.
 */
async function bestQuote(
  request: SolanaQuoteRequest,
): Promise<{ readonly quote: SolanaQuote; readonly via: NamedRoute }> {
  const answers = await Promise.all(
    routes().map((via) =>
      via.route.quote(request).then(
        (quote) => ({ quote, via }),
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          return { reason: `${via.name}: ${reason.replace(/\.$/u, "")}` };
        },
      ),
    ),
  );
  const top = answers.reduce<{ quote: SolanaQuote; via: NamedRoute } | null>(
    (top, answer) =>
      "quote" in answer && (!top || answer.quote.outAmount > top.quote.outAmount) ? answer : top,
    null,
  );
  if (top) return top;
  throw new Error(
    `${answers.map((answer) => ("reason" in answer ? answer.reason : "")).join("; ")}.`,
  );
}

/** The route a card was quoted on, by the name it pinned. */
function pinnedRoute(approved: Approved): NamedRoute {
  const via = routes().find(({ name }) => name === approved.details.venue);
  if (!via)
    throw new Error(
      `The route this card was quoted on (${approved.details.venue ?? "none"}) isn't here any more. Nothing was sent.`,
    );
  return via;
}

interface SwapPlan {
  readonly token: SolanaToken;
  /** Dollars per token as the portfolio counts it, in raw units. */
  readonly usdPrice: number;
  readonly side: "buy" | "sell";
  /** USDC for a buy, raw token units for a sell. */
  readonly amountIn: bigint;
  readonly slippageBps: number;
}

/**
 * `owner` is the wallet a sell naming no amount sells from, null while there is
 * none to hold anything; see `wholeSale` for how much.
 */
async function plan(
  swap: SolanaSwapInput,
  owner: () => Promise<string | null>,
  specialistHolds: SpecialistHolds | undefined,
): Promise<SwapPlan> {
  const sellsAll =
    swap.side === "sell" && swap.amountUsd === undefined && swap.tokenAmount === undefined;
  if (!sellsAll && (swap.amountUsd === undefined) === (swap.tokenAmount === undefined)) {
    throw new Error("Pass exactly one of amountUsd or tokenAmount, or neither to sell everything.");
  }
  const token = await resolveSolanaToken(swap.token);
  if (token.mint === SOLANA_USDC.mint)
    throw new Error("Pick the token to trade against USDC, not USDC itself.");
  // A route prices an xStock per wallet share, which its multiplier scales up
  // from the raw units the portfolio, fills and specialist holds all count in.
  const price = await solanaPrice(token.mint);
  const usdPrice = price.usdPrice * price.multiplier;
  const slippageBps = swap.slippageBps ?? 100;

  if (swap.side === "buy") {
    const spendUsd = swap.amountUsd ?? (swap.tokenAmount ?? 0) * usdPrice;
    const amountIn = toBaseUnits(spendUsd, SOLANA_USDC.decimals);
    return { token, usdPrice, side: "buy", amountIn, slippageBps };
  }
  // Selling everything sells exact raw units, since any amount converted
  // back from shares or dollars can land a crumb short of them.
  let amountIn: bigint;
  if (sellsAll) {
    const holder = await owner();
    const balance = holder
      ? await solanaTokenBalance(address(holder), token.mint, token.tokenProgram)
      : 0n;
    amountIn = wholeSale(balance, solanaMintKey(token.mint), token.decimals, specialistHolds);
    if (amountIn === 0n)
      throw new Error(
        `No ${token.symbol} held on Solana ${specialistHolds ? "for this specialist " : ""}to sell.`,
      );
  } else {
    amountIn = toBaseUnits(swap.tokenAmount ?? (swap.amountUsd ?? 0) / usdPrice, token.decimals);
  }
  return { token, usdPrice, side: "sell", amountIn, slippageBps };
}

function quoteRequest(swap: SwapPlan) {
  const [inputMint, outputMint] =
    swap.side === "buy" ? [SOLANA_USDC.mint, swap.token.mint] : [swap.token.mint, SOLANA_USDC.mint];
  return { inputMint, outputMint, amount: swap.amountIn, slippageBps: swap.slippageBps };
}

function tokenLabel(token: SolanaToken): string {
  return token.name.toLowerCase().includes(token.symbol.toLowerCase())
    ? token.name
    : `${token.name} (${token.symbol})`;
}

/**
 * How much of a trade's dollars it loses the moment it fills, in percent:
 * what it gets against what it gives, both at the token's price, as an EVM swap's is, since a
 * thin or seeded pool prices against its own. A buy takes its route's own impact where that is
 * worse, for a token whose last swap was pushed off its worth.
 */
function lostPct(swap: SwapPlan, quote: SolanaQuote): number {
  const tokens = fromBaseUnits(
    swap.side === "buy" ? quote.outAmount : swap.amountIn,
    swap.token.decimals,
  );
  const usdc = fromBaseUnits(swap.side === "buy" ? swap.amountIn : quote.outAmount, 6);
  if (swap.side === "sell") return (1 - usdc / (tokens * swap.usdPrice)) * 100;
  return Math.max((1 - (tokens * swap.usdPrice) / usdc) * 100, quote.priceImpactPct);
}

/**
 * `stock` names the tokenized stock a stock trade buys or sells, so its card reads as shares;
 * `limit` is how much it may lose the moment it fills before a specialist won't make it alone;
 * `topUp` is how a wallet paying its own way buys the SOL it is short, on the card as SOL for fees.
 * Its effect is what Auni asks the route for: the sale out of the wallet, and at least the
 * quote's least back into it, which execute's simulation of the route's bytes holds it to.
 */
function preview(
  swap: SwapPlan,
  { quote, via }: { readonly quote: SolanaQuote; readonly via: NamedRoute },
  limit: number,
  { stock, topUp }: { readonly stock?: XStock; readonly topUp?: SolTopUp | null } = {},
): ActionPreview {
  const usdValue = fromBaseUnits(swap.side === "buy" ? swap.amountIn : quote.outAmount, 6);
  const tokens = fromBaseUnits(
    swap.side === "buy" ? quote.outAmount : swap.amountIn,
    swap.token.decimals,
  );
  const symbol = swap.token.symbol;
  // What it loses to the market, at the token's price.
  const marketUsd = tokens * swap.usdPrice;
  const impact = swap.side === "buy" ? usdValue - marketUsd : marketUsd - usdValue;
  const costs = tradeCosts(impact);
  const least = fromBaseUnits(quote.minOutAmount, swap.side === "buy" ? swap.token.decimals : 6);
  const summary =
    swap.side === "buy"
      ? `Buy about ${usdLabel(usdValue)} of ${tokenLabel(swap.token)} on Solana`
      : `Sell ${formatAmount(tokens)} ${symbol} (about ${usdLabel(usdValue)}) on Solana`;
  const sizes: Record<string, string> =
    swap.side === "buy"
      ? {
          estimatedTokens: `${formatAmount(tokens)} ${symbol}`,
          minimumTokens: `${formatAmount(fromBaseUnits(quote.minOutAmount, swap.token.decimals))} ${symbol}`,
        }
      : {
          sell: `${formatAmount(tokens)} ${symbol}`,
          minimumReceive: usdLabel(least),
          // What the quote pays out.
          returnsUsd: usd(fromBaseUnits(quote.outAmount, 6)),
        };
  const trade: TradeTerms = {
    side: swap.side,
    symbol: stock?.symbol ?? symbol,
    stock: stock ? { company: stockName(stock), ticker: stock.ticker } : null,
    chain: "solana",
    receive: swap.side === "buy" ? formatAmount(tokens) : null,
    selling: swap.side === "sell" ? `${formatAmount(tokens)} ${symbol}` : null,
    atLeast: swap.side === "sell" ? usdLabel(least) : null,
    price: priceLabel(swap.usdPrice),
    costs: costsLabel(costs),
  };
  const made: ActionPreview = {
    ...(lostPct(swap, quote) > limit ? { unpriced: "loses on fill" as const } : {}),
    summary,
    // A sell spends no cash.
    amountUsd: swap.side === "buy" ? usd(usdValue) : "0",
    effect: {
      gives: [
        swap.side === "buy"
          ? { text: `${usdLabel(usdValue)} of USDC` }
          : { text: `${formatAmount(tokens)} ${symbol}`, usd: marketUsd },
      ],
      gets: [
        swap.side === "buy"
          ? { text: `about ${formatAmount(tokens)} ${symbol}, at least ${formatAmount(least)}` }
          : {
              text: `about ${usdLabel(fromBaseUnits(quote.outAmount, 6))} of USDC, at least ${usdLabel(least)}`,
            },
      ],
      grants: [],
      costs,
    },
    details: {
      // The least the card says it gets, which execute's transaction holds (see quoteHoldingProceeds).
      [APPROVED_PROCEEDS]: formatUnits(
        quote.minOutAmount,
        swap.side === "buy" ? swap.token.decimals : 6,
      ),
      chain: "solana",
      // The route it was quoted on, which execute builds on.
      venue: via.name,
      token: symbol,
      mint: swap.token.mint,
      price: priceLabel(swap.usdPrice),
      ...sizes,
      priceImpact: `${quote.priceImpactPct.toFixed(2)}%`,
      route: quote.route,
    },
    ...(swap.side === "sell"
      ? {
          sells: {
            ...solanaMintKey(swap.token.mint),
            quantity: formatUnits(swap.amountIn, swap.token.decimals),
          },
        }
      : {}),
  };
  return withTopUp(
    withFace(made, (said) => tradeFace(trade, said)),
    topUp ?? null,
  );
}

/** A trade that loses more than `maxLossPct` (MAX_BUY_IMPACT_PCT by default) the moment it fills never runs without a tap. */
export async function previewSolanaSwap(
  swap: SolanaSwapInput,
  options: {
    readonly owner: () => Promise<string | null>;
    readonly specialistHolds?: SpecialistHolds | undefined;
    readonly maxLossPct?: number;
    readonly stock?: XStock;
  },
): Promise<ActionPreview> {
  // A wallet with no Solana key trades nothing there, said before any route is asked.
  if (!(await options.owner())) throw new Error(noAddressOn("Solana"));
  const planned = await plan(swap, options.owner, options.specialistHolds);
  const best = await bestQuote(quoteRequest(planned));
  const topUp = await solForSwap(planned, best.via.route, options.owner);
  return preview(planned, best, options.maxLossPct ?? MAX_BUY_IMPACT_PCT, {
    ...(options.stock ? { stock: options.stock } : {}),
    topUp,
  });
}

/**
 * How a wallet that pays its own Solana fees buys the SOL this swap's fee and the accounts it
 * opens need, read from the route's own bytes simulated from it, or null when it holds enough or
 * its sponsor pays (see sol-top-up.ts). A wallet that doesn't hold what the swap spends yet, as
 * when an earlier move on the same card brings the cash, can't run the swap in a simulation, so
 * there its bytes run without the swap itself (setupOnly): they still open and pay all the swap
 * would. Whether the cash will be there is for the card's funding to say (money/funding.ts), and
 * execute checks it is before anything is sent.
 */
async function solForSwap(
  planned: SwapPlan,
  route: SolanaRoute,
  owner: () => Promise<string | null>,
): Promise<SolTopUp | null> {
  const holder = await owner();
  if (!holder || !(await paysOwnGas("solana"))) return null;
  const taker = address(holder);
  const [paid, program] =
    planned.side === "buy"
      ? [SOLANA_USDC.mint, SOLANA_USDC.tokenProgram]
      : [planned.token.mint, planned.token.tokenProgram];
  const [built, held] = await Promise.all([
    route.build({ ...quoteRequest(planned), taker }),
    solanaTokenBalance(taker, paid, program),
  ]);
  const funded = held >= planned.amountIn;
  const { short } = await simulateSolana(
    built.transactionBase64,
    taker,
    funded ? {} : { setupOnly: true },
  );
  return short ? solForFees(short, { spends: spentUsdc(planned) }) : null;
}

/** The Solana USDC a swap itself spends, which buying its SOL can't spend too. */
const spentUsdc = (planned: SwapPlan) => (planned.side === "buy" ? planned.amountIn : 0n);

/**
 * Quotes fresh and sends, held to the card: never more spent or sold than it
 * allowed, nor less got than it said at least. The route built the swap's bytes,
 * so they're simulated from the wallet first and held to that too.
 */
export async function executeSolanaSwap(
  swap: SolanaSwapInput,
  wallets: Signer,
  approved: Approved,
  options: { readonly specialistHolds?: SpecialistHolds | undefined } = {},
): Promise<ExecuteResult> {
  const taker = address(wallets.solanaAddress);
  const { route } = pinnedRoute(approved);
  const pinned = { ...swap, token: pinnedToken(approved, "mint") };
  let planned = await plan(pinned, async () => taker, options.specialistHolds);

  if (planned.side === "buy") {
    const usdc = await solanaTokenBalance(taker, SOLANA_USDC.mint, SOLANA_USDC.tokenProgram);
    if (usdc < planned.amountIn) {
      throw new Error(
        `Only $${usd(fromBaseUnits(usdc, 6))} USDC on Solana, $${usd(fromBaseUnits(planned.amountIn, 6))} needed. Move USDC to Solana first.`,
      );
    }
    assertApprovedSpend(approved, planned.amountIn, planned.slippageBps);
  } else {
    const held = await solanaTokenBalance(taker, planned.token.mint, planned.token.tokenProgram);
    // A full exit sized from the portfolio's rounded amount can overshoot the raw balance.
    if (planned.amountIn > held && planned.amountIn <= (held * 101n) / 100n)
      planned = { ...planned, amountIn: held };
    if (planned.amountIn > held) {
      throw new Error(
        `Only ${formatAmount(fromBaseUnits(held, planned.token.decimals))} ${planned.token.symbol} held on Solana.`,
      );
    }
    assertApprovedSale(approved, planned.amountIn, planned.token.decimals);
  }

  // The market may have moved since the card, but what the swap lets land never falls under the
  // least it said it gets.
  const build = () =>
    quoteHoldingProceeds(
      approved,
      planned.side === "buy" ? planned.token.decimals : SOLANA_USDC.decimals,
      planned.slippageBps,
      (slippageBps) => route.build({ ...quoteRequest(planned), slippageBps, taker }),
      ({ quote }) => ({ expected: quote.outAmount, least: quote.minOutAmount }),
    );
  let built = await build();
  let simulated = await simulateSolana(built.transactionBase64, taker);
  const txs: SentTx[] = [];
  if (simulated.short) {
    // A wallet paying its own way, short of SOL for the swap, buys it first, as its card's
    // network fee showed, then the swap is built again on a blockhash the wait can't outlive.
    txs.push(
      ...(await topUpSol(
        wallets,
        await solForFees(simulated.short, { spends: spentUsdc(planned), approved }),
      )),
    );
    built = await build();
    simulated = await simulateSolana(built.transactionBase64, taker);
    if (simulated.short)
      throw new Error(
        "The wallet is still short of SOL after buying some, so the swap wasn't sent. Propose it again.",
      );
  }
  const [paid, got] =
    planned.side === "buy"
      ? [SOLANA_USDC.mint, planned.token.mint]
      : [planned.token.mint, SOLANA_USDC.mint];
  assertBytesDo(simulated.effect, {
    gives: [{ token: paid, amount: planned.amountIn }],
    gets: [{ token: got, amount: built.quote.minOutAmount }],
  });
  const hash = await wallets.sendSolanaTransaction(built.transactionBase64);
  // What the transaction really moved, not what the quote promised: the input is exact, the output isn't.
  const received =
    (await landedEffect(hash, taker)).in.find(({ token }) => token === got)?.amount ?? 0n;
  if (received <= 0n) throw new Error(`The swap ${hash} landed but nothing arrived in the wallet.`);
  return {
    txs: [...txs, { chain: "solana", hash }],
    // In raw units, as the portfolio reads the wallet.
    fills: [
      {
        ...solanaMintKey(planned.token.mint),
        side: planned.side,
        quantity: formatUnits(
          planned.side === "buy" ? received : planned.amountIn,
          planned.token.decimals,
        ),
        usdValue: formatUnits(planned.side === "buy" ? planned.amountIn : received, 6),
      },
    ],
  };
}

/**
 * What a Solana swap whose run stopped after sending traded, read back from the transaction
 * that landed (see Recipe.readBack): the token its card pinned against USDC, as execute records
 * it. Null when the wallet's side of it can't be read from that transaction.
 */
export async function readBackSolanaSwap(
  action: Pick<ActionRow, "details" | "txs">,
  side: "buy" | "sell",
  owner: string | null,
): Promise<ReadBack | null> {
  const hash = action.txs.findLast((tx) => tx.chain === "solana" && tx.hash && !tx.setup)?.hash;
  const { mint } = action.details;
  if (!owner || !hash || !mint) return null;
  const [landed, token] = await Promise.all([
    landedEffect(hash, address(owner)),
    resolveSolanaToken(mint),
  ]);
  const [paid, got] = side === "buy" ? [SOLANA_USDC.mint, mint] : [mint, SOLANA_USDC.mint];
  const sent = landed.out.find(({ token: each }) => each === paid)?.amount ?? 0n;
  const received = landed.in.find(({ token: each }) => each === got)?.amount ?? 0n;
  if (sent <= 0n || received <= 0n) return null;
  const [units, usdc] = side === "buy" ? [received, sent] : [sent, received];
  return {
    fills: [
      {
        ...solanaMintKey(mint),
        side,
        quantity: formatUnits(units, token.decimals),
        usdValue: formatUnits(usdc, 6),
      },
    ],
  };
}

export const solanaSwap: Recipe<typeof input> = {
  tool: "solana_swap",
  // A wallet with no Solana key can't trade there, so it isn't offered this.
  description: ({ solana }) =>
    !solana
      ? null
      : "Buy or sell any liquid Solana token against the owner's Solana USDC, at the best route's quote, including " +
        "tokenized stocks (NVDAx, TSLAx, SPYx and other xStocks). Size by dollars or by token amount. " +
        "Buys spend USDC on Solana (short there, one propose_actions card brings it and buys); no SOL is needed for gas: a wallet that pays its own " +
        "network fees and holds too little SOL buys some with a little USDC first, shown on the " +
        "card as SOL for fees, most of which stays in the wallet. Prefer stock_trade for stocks.",
  input,
  venue: "solana-swap",
  mark: "swap",
  describe: (swap, { specialistHolds }) =>
    previewSolanaSwap(swap, { owner: solanaAddress, specialistHolds }),
  direction: (swap) => swap.side,
  fundedFrom: ({ input: swap }) => (swap.side === "buy" ? "solana" : null),
  about: ({ input: swap, details, amountUsd }) =>
    tradedToken(details, swap.side === "buy" ? Number(amountUsd) : 0),
  execute: ({ input: swap, wallets, action, specialistHolds }) =>
    executeSolanaSwap(swap, wallets, action, { specialistHolds }),
  readBack: ({ action, input: swap, solanaAddress: owner }) =>
    readBackSolanaSwap(action, swap.side, owner),
};
