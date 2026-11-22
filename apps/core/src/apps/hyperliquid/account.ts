import type { Signer } from "../../money/recipe.ts";
import { parseUnits } from "../../money/usd.ts";
import { info, nextNonce, sendL1, sendUserSigned } from "./api.ts";
import { dexOf, listDexes, tradedMarkets, type Market } from "./markets.ts";
import { refusedOrders } from "./problems.ts";
import { SIGNATURE_CHAIN_ID_HEX, USER_SET_ABSTRACTION_FIELDS } from "./signing.ts";

interface ClearinghouseState {
  readonly withdrawable: string;
  readonly marginSummary: { readonly accountValue: string };
  readonly assetPositions: readonly {
    readonly position: {
      readonly coin: string;
      readonly szi: string;
      readonly entryPx: string | null;
      readonly liquidationPx: string | null;
      readonly unrealizedPnl: string;
      readonly marginUsed: string;
      readonly leverage: { readonly type: "isolated" | "cross"; readonly value: number };
    };
  }[];
}

interface SpotState {
  readonly balances: readonly {
    readonly coin: string;
    readonly total: string;
    readonly hold: string;
  }[];
}

/**
 * Everything one Hyperliquid account holds: its spot balances, its state on each perps dex, and
 * whether spot and every dex share one USDC balance (Hyperliquid's unified account, or portfolio
 * margin), as Auni makes them before its first order or withdrawal.
 */
interface HyperliquidAccount {
  readonly spot: SpotState;
  readonly dexes: readonly ClearinghouseState[];
  readonly pooled: boolean;
}

/** The modes in which spot and every perps dex draw on one balance (userAbstraction). */
const POOLED_MODES = new Set(["unifiedAccount", "portfolioMargin"]);

function clearinghouseState(user: string, dex: string): Promise<ClearinghouseState> {
  return info({ type: "clearinghouseState", user, ...(dex === "" ? {} : { dex }) });
}

/** How the account keeps its balances; Hyperliquid's userAbstraction answer. */
async function accountMode(user: string): Promise<string> {
  const mode = await info<string | null>({ type: "userAbstraction", user });
  // It has answered null for an account that is unified, when asked too often.
  if (typeof mode !== "string") throw new Error("Hyperliquid didn't say how the account is kept.");
  return mode;
}

/**
 * The owner's account `user` (an address): its spot balances, how it keeps
 * them, and its state on `dexes`: by default the main perps dex and the dex of
 * each market Auni has traded there (see tradedMarkets). Auni puts money on a
 * dex only by trading there, so these are every dex holding money or a
 * position Auni put there; the main one is always read, since deposits land
 * there. Another dex is skipped, as a token Auni never bought is: each costs
 * as much to read as spot, and there are a dozen.
 */
export async function readAccount(
  user: string,
  dexes?: readonly string[],
): Promise<HyperliquidAccount> {
  // Which dexes is known before any read starts, so none is left unawaited should that fail.
  const read = dexes ?? (await accountDexes());
  const [mode, spot, ...states] = await Promise.all([
    accountMode(user),
    info<SpotState>({ type: "spotClearinghouseState", user }),
    ...read.map((dex) => clearinghouseState(user, dex)),
  ]);
  return { spot, dexes: states, pooled: POOLED_MODES.has(mode) };
}

/** The perps dexes an account read covers, by name (see readAccount): the main one ("") first. */
export async function accountDexes(): Promise<string[]> {
  const [listed, traded] = await Promise.all([listDexes(), tradedMarkets()]);
  const wanted = new Set(["", ...traded.map(dexOf)]);
  // Only dexes still listed: asking for any other is an HTTP 500 that would fail the whole read.
  return listed.flatMap((dex) => (wanted.has(dex.name) ? [dex.name] : []));
}

// Hyperliquid's dollar strings in micro-dollars, exactly; an account's value can be below zero.
function micros(value: string): bigint {
  return value.startsWith("-") ? -parseUnits(value.slice(1), 6) : parseUnits(value, 6);
}

type Position = ClearinghouseState["assetPositions"][number]["position"];

/** Where an account's USDC is, in micro-dollars: every part of it is the owner's. */
interface Split {
  /** Free to spend or withdraw now. */
  readonly free: bigint;
  /** Held for orders still waiting: it comes back as cash when they are cancelled. */
  readonly onOrders: bigint;
  /** Each open position, worth what closing it would free. */
  readonly positions: readonly { readonly position: Position; readonly micros: bigint }[];
}

/**
 * Splits an account's USDC into what is free, what open orders hold, and what
 * each open position is worth, which add up to its value.
 *
 * Hyperliquid reports money in pockets: what is in one is free, or held. A
 * unified account is one pocket, spot's USDC, whose total is the account's
 * value (its positions' profit and loss included) and whose hold is what every
 * position and waiting order across every dex holds; Hyperliquid's docs say a
 * dex's own state means nothing there. A standard account has spot's pocket,
 * where only a spot order holds, and one per dex: its account value, of which
 * the withdrawable part is free.
 *
 * Within a pocket, what is held goes first to each isolated position, worth
 * exactly its margin, which carries its profit and loss; every position Auni
 * opens is isolated. Cross positions, opened elsewhere, share the rest by the
 * margin each uses: Hyperliquid holds more than that for them, and frees it
 * all once they close, and what an order holds beside them can't be told
 * apart. With none open, the rest is what orders hold.
 */
export function splitAccount(account: HyperliquidAccount): Split {
  const usdc = account.spot.balances.find((balance) => balance.coin === "USDC");
  const spot = {
    free: usdc ? micros(usdc.total) - micros(usdc.hold) : 0n,
    held: usdc ? micros(usdc.hold) : 0n,
    positions: account.pooled ? account.dexes.flatMap(openPositions) : [],
  };
  const dexes = account.pooled
    ? []
    : account.dexes.map((state) => {
        const withdrawable = micros(state.withdrawable);
        const free = withdrawable > 0n ? withdrawable : 0n;
        return {
          free,
          held: micros(state.marginSummary.accountValue) - free,
          positions: openPositions(state),
        };
      });
  let free = 0n;
  let onOrders = 0n;
  const positions: { position: Position; micros: bigint }[] = [];
  for (const pocket of [spot, ...dexes]) {
    if (pocket.free > 0n) free += pocket.free;
    let rest = pocket.held;
    const cross = pocket.positions.filter((position) => position.leverage.type === "cross");
    for (const position of pocket.positions)
      if (position.leverage.type !== "cross") {
        positions.push({ position, micros: micros(position.marginUsed) });
        rest -= micros(position.marginUsed);
      }
    if (rest <= 0n) continue;
    const margins = cross.map((position) => micros(position.marginUsed));
    const total = margins.reduce((sum, margin) => sum + margin, 0n);
    if (total === 0n) onOrders += rest;
    else
      cross.forEach((position, index) =>
        positions.push({ position, micros: (rest * margins[index]!) / total }),
      );
  }
  return { free, onOrders, positions };
}

function openPositions(state: ClearinghouseState): Position[] {
  return state.assetPositions
    .map((entry) => entry.position)
    .filter((position) => Number(position.szi) !== 0);
}

/** USDC free to spend or withdraw, in whole cents rounded down (see splitAccount). */
export async function hyperliquidFreeCents(user: string): Promise<bigint> {
  return splitAccount(await readAccount(user)).free / 10_000n;
}

/**
 * The open position on a market: its signed size, what it's worth as splitAccount
 * values it, its leverage, what it has made or lost so far, and the price
 * that would wipe it out.
 */
export async function readPosition(
  user: string,
  market: Market,
): Promise<{
  readonly size: number;
  readonly szi: string;
  readonly valueUsd: number;
  readonly leverage: number;
  readonly pnlUsd: number;
  /** Its average entry price; null where Hyperliquid gives none. */
  readonly entryPx: number | null;
  readonly liquidationPx: number | null;
} | null> {
  const held = splitAccount(await readAccount(user, [market.dex])).positions.find(
    ({ position }) => position.coin === market.name,
  );
  if (!held) return null;
  const { position } = held;
  return {
    size: Number(position.szi),
    szi: position.szi,
    valueUsd: Number(held.micros / 10_000n) / 100,
    leverage: position.leverage.value,
    pnlUsd: Number(position.unrealizedPnl),
    entryPx: position.entryPx === null ? null : Number(position.entryPx),
    liquidationPx: position.liquidationPx === null ? null : Number(position.liquidationPx),
  };
}

/**
 * Puts the account in Hyperliquid's unified mode, where spot and every perps
 * dex draw on one USDC balance, so cash anywhere in it can margin any order
 * or be withdrawn. In the standard mode each dex keeps its own, and withdraw3
 * reaches only the main dex's. Portfolio margin pools them too.
 */
export async function ensureUnifiedAccount(wallets: Signer): Promise<void> {
  const mode = await info<string | null>({ type: "userAbstraction", user: wallets.evmAddress });
  if (mode !== null && POOLED_MODES.has(mode)) return;
  await sendUserSigned(wallets, "UserSetAbstraction", USER_SET_ABSTRACTION_FIELDS, {
    type: "userSetAbstraction",
    signatureChainId: SIGNATURE_CHAIN_ID_HEX,
    hyperliquidChain: "Mainnet",
    user: wallets.evmAddress.toLowerCase(),
    abstraction: "unifiedAccount",
    nonce: nextNonce(),
  });
}

/** Each position open on one perps dex: its market, which way it is, and its size in coins. */
export async function positionsOn(user: string, dex: string) {
  const state = await clearinghouseState(user, dex);
  return state.assetPositions
    .map(({ position }) => position)
    .filter((position) => Number(position.szi) !== 0)
    .map((position) => ({
      market: position.coin,
      side: position.szi.startsWith("-") ? ("short" as const) : ("long" as const),
      size: position.szi.replace("-", ""),
      leverage: position.leverage.value,
    }));
}

// Every position Auni opens is isolated. Leverage has no read before a position exists, so it is always written.
export async function setLeverage(
  wallets: Signer,
  market: Market,
  leverage: number,
): Promise<void> {
  await sendL1(wallets, {
    type: "updateLeverage",
    asset: market.assetId,
    isCross: false,
    leverage,
  });
}

/**
 * Cancels orders on one market by their ids, and says what Hyperliquid said of each it refused
 * to: one that had already filled or been cancelled is refused, and the rest still go.
 */
export async function cancelOrders(
  wallets: Signer,
  market: Market,
  oids: readonly number[],
): Promise<readonly string[]> {
  if (oids.length === 0) return [];
  return refusedOrders(
    await sendL1(wallets, {
      type: "cancel",
      cancels: oids.map((oid) => ({ a: market.assetId, o: oid })),
    }),
  );
}

/**
 * Cancels orders on one market by the tags Auni sent them with (see orderTag), which is how a
 * move takes back a stop it has just placed: Hyperliquid answers a stop with no order id. Says
 * what Hyperliquid said of each it refused to, as cancelOrders does.
 */
export async function cancelTagged(
  wallets: Signer,
  market: Market,
  tags: readonly string[],
): Promise<readonly string[]> {
  if (tags.length === 0) return [];
  return refusedOrders(
    await sendL1(wallets, {
      type: "cancelByCloid",
      cancels: tags.map((cloid) => ({ asset: market.assetId, cloid })),
    }),
  );
}
