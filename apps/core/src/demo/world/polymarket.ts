import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  parseAbi,
  parseUnits,
  type Address,
} from "viem";

import { refuse, type Asked, type Service } from "../world.ts";
import { addressOf, chains, Reverted } from "./chain.ts";
import { curveDays } from "./prices.ts";

// The demo's Polymarket: the owner's deposit wallet on Polygon, the outcome shares it holds,
// each share's price over time, and a book that buys those shares back. A position is one the
// owner brought with them, and the demo can sell it: a sale needs only Polymarket's book. A buy,
// and bringing its cash home, would need its relayer too, which the demo has no stand-in for, so
// the demo does neither.

/** Polymarket's deposit-wallet factory on Polygon, and the wallet it predicts for the owner. */
const FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET = addressOf("polymarket deposit wallet");
const factoryAbi = parseAbi([
  "function predictWalletAddress(bytes32 salt) view returns (address)",
  "function predictLegacyWalletAddress(bytes32 salt) view returns (address)",
]);

/** The contract that holds every market's shares, which the book is let trade. */
const SHARES = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
/** Whoever is on the other side of a sale: the book's own account. */
const BOOK = addressOf("polymarket book");
const sharesAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
]);

const polygon = chains.get("polygon")!;
polygon.deploy(FACTORY, () => ({
  returned: encodeFunctionResult({
    abi: factoryAbi,
    functionName: "predictWalletAddress",
    result: DEPOSIT_WALLET,
  }),
  logs: [],
}));
// The wallet exists, as one that has traded does; it takes no call the demo makes.
polygon.deploy(DEPOSIT_WALLET, () => {
  throw new Reverted("The demo's Polymarket wallet runs nothing.");
});
// Its collateral tokens, of which the wallet holds none until a sale pays it: the owner's cash
// is in their own wallet.
for (const [symbol, address] of [
  ["pUSD", PUSD],
  ["USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"],
] as const)
  polygon.list(address, { symbol, name: symbol, decimals: 6 });

interface Outcome {
  readonly tokenId: string;
  readonly title: string;
  readonly outcome: string;
  /** Shares the owner holds, and what each cost them. */
  shares: number;
  readonly paid: number;
  /** Its chance as the demo starts, and how much of that it gained each day. */
  readonly chance: number;
  readonly trend: number;
}

/** The one bet the demo's owner made before Auni. */
const FED_CUT: Outcome = {
  tokenId: "52114319501245915516055106046884209969926127482827954674443846427813813222426",
  title: "Will the Fed cut rates in December?",
  outcome: "Yes",
  shares: 620,
  paid: 0.52,
  chance: 0.64,
  trend: 0.006,
};
const OUTCOMES: readonly Outcome[] = [FED_CUT];

/** An owner new to Auni (`auni demo --first-run`) brought no bet with them. */
export function heldNoBets(): void {
  for (const held of OUTCOMES) held.shares = 0;
}

/** The market the owner's bet is on, as Polymarket's book describes it. */
export const FED_MARKET = {
  conditionId: "0x5fe1d0b9a4c7f2e8d3b6a19c0e47f2d8b3a6c5e4f1d0b9a8c7e6f5d4c3b2a190",
  /** What Polymarket keeps of a trade there: its rate for a market on the economy. */
  feeRate: 0.05,
} as const;
/** The other side of the bet, which the owner holds none of. */
const NO_TOKEN = "52114319501245915516055106046884209969926127482827954674443846427813813222427";

// The owner's shares, as their contract says them, which the book may already trade.
polygon.deploy(SHARES, (call) => {
  const { functionName, args } = decodeFunctionData({ abi: sharesAbi, data: call.data });
  if (functionName === "isApprovedForAll")
    return {
      returned: encodeFunctionResult({ abi: sharesAbi, functionName, result: true }),
      logs: [],
    };
  const held = OUTCOMES.find(({ tokenId }) => BigInt(tokenId) === args[1]);
  const mine = args[0].toLowerCase() === DEPOSIT_WALLET.toLowerCase();
  return {
    returned: encodeFunctionResult({
      abi: sharesAbi,
      functionName,
      result: held && mine ? parseUnits(held.shares.toFixed(6), 6) : 0n,
    }),
    logs: [],
  };
});

/** An outcome's chance at `at`: a slow climb with a little noise, the same on every run. */
function chanceAt(outcome: Outcome, at: number): number {
  const days = curveDays(at);
  const chance = outcome.chance + outcome.trend * days + 0.015 * Math.sin(days * 2.3);
  return Math.min(0.97, Math.max(0.03, Number(chance.toFixed(3))));
}

/** The best price the book pays for an outcome's shares now, on the market's one-cent grid. */
const bid = (outcome: Outcome) => Math.floor(chanceAt(outcome, Date.now()) * 100 - 1) / 100;

/**
 * Takes a sale of the owner's shares as the real book takes an order that fills at once: the
 * shares leave, and their price less Polymarket's fee is paid into the deposit wallet as pUSD,
 * in a transaction the answer names. Anything else is refused as the real book words it.
 */
function sell(order: { tokenId: string; makerAmount: string; takerAmount: string; side: string }) {
  const held = OUTCOMES.find(({ tokenId }) => tokenId === order.tokenId);
  const shares = Number(order.makerAmount) / 1e6;
  if (order.side !== "SELL" || !held || shares > held.shares + 1e-9)
    return refuse(400, { error: "not enough balance / allowance" });
  const price = bid(held);
  if (shares * price < Number(order.takerAmount) / 1e6)
    return refuse(400, {
      error:
        "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.",
    });
  const fee = shares * FED_MARKET.feeRate * price * (1 - price);
  const paid = parseUnits((shares * price - fee).toFixed(6), 6);
  held.shares -= shares;
  polygon.credit(PUSD, BOOK, paid);
  const hash = polygon.send(BOOK, [
    {
      to: PUSD as Address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [DEPOSIT_WALLET, paid],
      }),
      value: 0n,
    },
  ]);
  return {
    success: true,
    errorMsg: "",
    orderID: `demo-${hash.slice(2, 10)}`,
    status: "matched",
    makingAmount: shares.toFixed(6),
    takingAmount: (shares * price).toFixed(6),
    transactionsHashes: [hash],
    tradeIDs: [],
  };
}

/**
 * The Fed market as Polymarket's list of what is trending gives it, wearing the picture
 * Polymarket shows for its Fed decision markets, from its own image host.
 */
function trending() {
  const chance = chanceAt(FED_CUT, Date.now());
  return {
    title: FED_CUT.title,
    slug: "fed-decision-in-december",
    volume24hr: 4_210_000,
    icon: "https://polymarket-upload.s3.us-east-2.amazonaws.com/fed-decision-in-september-762-c4RyWuxRPo1L.jpg",
    markets: [
      {
        question: FED_CUT.title,
        conditionId: FED_MARKET.conditionId,
        slug: "fed-decision-in-december",
        clobTokenIds: JSON.stringify([FED_CUT.tokenId, NO_TOKEN]),
        active: true,
        closed: false,
        enableOrderBook: true,
        outcomes: JSON.stringify(["Yes", "No"]),
        outcomePrices: JSON.stringify([String(chance), String(1 - chance)]),
      },
    ],
  };
}

let unanswered = false;

/**
 * Has the book give the next order no answer, once, as the real one can on a bad night: the
 * order never goes in, and whoever sent it can't tell. How a scene shows a held move.
 */
export function dropNextOrder(): void {
  unanswered = true;
}

/**
 * Where Polymarket's region check finds this machine: somewhere it takes bets, until a scene
 * moves the demo to Australia, where it takes none new (fixtures/geoblock/blocked-au.json).
 * Auni keeps the answer ten minutes, so a scene that moves it is played before anything has
 * asked, as a fresh demo is.
 */
let here = { blocked: false, ip: "203.0.113.42", country: "CH", region: "ZH" };

/** Has Polymarket find this machine in New South Wales, from here on. */
export function inAustralia(): void {
  here = { blocked: true, ip: "203.0.113.9", country: "AU", region: "NSW" };
}

export const polymarket: Service = {
  hosts: [
    "data-api.polymarket.com",
    "clob.polymarket.com",
    "gamma-api.polymarket.com",
    "polymarket.com",
  ],
  answer({ url, method, body }: Asked) {
    const outcome = (id: string | null) => OUTCOMES.find(({ tokenId }) => tokenId === id);
    if (url.hostname === "polymarket.com")
      return url.pathname === "/api/geoblock" ? here : undefined;
    if (url.hostname === "data-api.polymarket.com") {
      if (url.pathname === "/v2/positions") {
        const mine = url.searchParams.get("user")?.toLowerCase() === DEPOSIT_WALLET.toLowerCase();
        return {
          data: (mine ? OUTCOMES.filter(({ shares }) => shares > 0) : []).map((held) => ({
            token_id: held.tokenId,
            current_size: held.shares,
            current_value: held.shares * chanceAt(held, Date.now()),
            title: held.title,
            outcome: held.outcome,
            avg_price: held.paid,
          })),
          pagination: { next_cursor: null },
        };
      }
      // Nothing has paid out.
      if (url.pathname === "/activity") return [];
      return undefined;
    }
    if (url.hostname === "clob.polymarket.com") {
      if (url.pathname === "/midpoint") {
        const held = outcome(url.searchParams.get("token_id"));
        return held ? { mid: String(chanceAt(held, Date.now())) } : undefined;
      }
      if (url.pathname === "/prices-history") {
        const held = outcome(url.searchParams.get("market"));
        if (!held) return { history: [] };
        const step = Number(url.searchParams.get("fidelity") ?? 60) * 60_000;
        const history = [];
        for (let at = Number(url.searchParams.get("startTs")) * 1_000; at < Date.now(); at += step)
          history.push({ t: Math.floor(at / 1_000), p: chanceAt(held, at) });
        return { history };
      }
      // The market and its book, which a sale is priced and placed against.
      if (url.pathname === `/markets/${FED_MARKET.conditionId}`)
        return {
          condition_id: FED_MARKET.conditionId,
          question: FED_CUT.title,
          tokens: [
            { token_id: FED_CUT.tokenId, outcome: "Yes" },
            { token_id: NO_TOKEN, outcome: "No" },
          ],
          minimum_tick_size: 0.01,
          neg_risk: false,
          accepting_orders: true,
          closed: false,
          end_date_iso: "2026-12-16T00:00:00Z",
        };
      if (url.pathname === `/markets-by-token/${FED_CUT.tokenId}`)
        return { condition_id: FED_MARKET.conditionId };
      if (url.pathname === `/clob-markets/${FED_MARKET.conditionId}`)
        return { fd: { r: FED_MARKET.feeRate, e: 1 } };
      if (url.pathname === "/book") {
        const held = outcome(url.searchParams.get("token_id"));
        if (!held) return undefined;
        const best = bid(held);
        const level = (price: number, size: number) => ({
          price: price.toFixed(2),
          size: String(size),
        });
        // The best price is listed last on either side.
        return {
          bids: [level(best - 0.02, 9_000), level(best - 0.01, 6_000), level(best, 4_000)],
          asks: [level(best + 0.04, 9_000), level(best + 0.03, 6_000), level(best + 0.02, 4_000)],
        };
      }
      // An account's key for the book, its refreshed balances, and an order.
      if (url.pathname === "/auth/api-key" || url.pathname === "/auth/derive-api-key")
        return { apiKey: "demo", secret: "ZGVtbw==", passphrase: "demo" };
      if (url.pathname === "/balance-allowance/update") return {};
      if (url.pathname === "/order" && method === "POST") {
        if (unanswered) {
          unanswered = false;
          return refuse(504, { error: "upstream request timeout" });
        }
        return sell((body as { order: Parameters<typeof sell>[0] }).order);
      }
      return undefined;
    }
    // What is trending, for a new chat's starting points: the demo's one market.
    if (url.pathname === "/events") return [trending()];
    // A search by theme: the demo's one market is on no theme a scene searches.
    if (url.pathname === "/public-search") return { events: [] };
    return undefined;
  },
};
