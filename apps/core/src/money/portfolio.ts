import { EVM_CASH_KEYS, isCash, isEvmChain, NETWORKS, type NetworkKey } from "@auni/shared";
import { and, eq, gt, isNotNull, min, type AnyColumn } from "drizzle-orm";
import { isAddress, type Address } from "viem";

import { db } from "../db/client.ts";
import { arrivals, fills, otherTokens } from "../db/schema.ts";
import { chainIdOf } from "./chains.ts";
import { allFills, buildPortfolio, withFillCosts, worthUsd } from "./books.ts";
import { readEvmWallet, readSavings, readSolanaWallet, namesOf } from "./chain-holdings.ts";
import { fillIdentity, instrumentIn, QUANTITY_DECIMALS, type FillKey } from "./fill-key.ts";
import { livePrices, movedUsd, perpSize, priceKey, pricesNow } from "./history.ts";
import { outdated, priceKeys, readStands, saveReading } from "./readings.ts";
import { onForget } from "./swaps/shared.ts";
import { onTheirWay } from "./record.ts";
import { centsToUsd, formatUnits, sumUsd, unitsUsd } from "./usd.ts";
import { walletAddresses } from "./wallets.ts";
import type { Account, AccountHolding, RawHolding } from "../apps/contract.ts";
import { accountOwning, accounts, savingsTokens } from "../apps/registry.ts";
import { countFirstLook, placeOf, stillLooking } from "./first-look.ts";

/** An EVM chain a fill or arrival names: one of Auni's, or another recorded as eip155:N. */
function isEvmPlace(chain: string): boolean {
  return Object.hasOwn(NETWORKS, chain)
    ? isEvmChain(chain as NetworkKey)
    : chain.startsWith("eip155:");
}

/**
 * A token an EVM wallet holds as itself: an ERC-20 by address, and not savings, which are read
 * on their own and filed under the app that keeps them.
 */
function isWalletToken(chain: string, instrument: string): boolean {
  return (
    /^0x[0-9a-fA-F]{40}$/u.test(instrument) &&
    !savingsTokens(chain).some(({ token }) => token.toLowerCase() === instrument.toLowerCase())
  );
}

/**
 * What an account keeps outside the owner's wallet where `chain` is: its whole ledger, or its
 * contracts on that chain. Null for what is kept in the wallet, which core reads itself.
 */
function keptAt(
  { kept }: Account,
  chain: string,
  owner: Address,
): Promise<readonly AccountHolding[]> | null {
  if ("wallet" in kept) return null;
  if ("ledger" in kept) return kept.ledger(owner);
  const on = kept.chains.find((each) => each === chain);
  return on ? kept.read(owner, on) : null;
}

/** Everything an account keeps for `owner` outside their wallet, on every chain it keeps any. */
export async function keptOutsideWallet(
  { kept }: Account,
  owner: Address,
): Promise<readonly AccountHolding[]> {
  if ("wallet" in kept) return [];
  if ("ledger" in kept) return kept.ledger(owner);
  return (await Promise.all(kept.chains.map((chain) => kept.read(owner, chain)))).flat();
}

/**
 * Live holdings across every wallet and venue, valued at live prices.
 * Free dollar stablecoins sit in Cash; everything else sits in Assets.
 */

export interface Holding extends FillKey {
  /** Who keeps it: "wallet" for the owner's own wallets, else the venue's app id (see readPortfolio). */
  readonly venue: string;
  readonly symbol: string;
  /** Whole units as a decimal string, at most `decimals` places. */
  readonly quantity: string;
  readonly decimals: number;
  /** Null when no live price exists; unpriced holdings add nothing to totals. */
  readonly usdValue: string | null;
  readonly cash: boolean;
  /**
   * Cash that orders waiting at an account hold: the owner's, counted in every total and in
   * what money made as cash, but not free to spend until they fill or are cancelled, so it is
   * shown beside Cash, never in it.
   */
  readonly heldForOrders?: true;
  /** Its price id (see Tokens in apps/contract.ts), or null when the value is already known in dollars. */
  readonly priceId: string | null;
  /** A perp position that gains when the price falls. */
  readonly short?: boolean;
  /** A perp position's leverage, as the venue sets it: 3 for 3x. */
  readonly leverage?: number;
  /**
   * What one unit cost on average, in dollars: from the venue's own book where
   * it keeps one (a prediction share's average price, a perp's entry price),
   * else from Auni's fills. Absent when nothing records what was paid.
   */
  readonly averageCostUsd?: string;
}

interface PortfolioBucket {
  readonly usdValue: string;
  readonly holdings: readonly Holding[];
}

export interface Portfolio {
  /** When the read began: it shows every move settled before then. */
  readonly observedAt: string;
  readonly totalUsd: string;
  /** Sources that could not be read; their value is missing from every total. */
  readonly unavailable: readonly string[];
  /**
   * The networks of the owner's wallets Auni hasn't made its first look at yet (see
   * stillLooking): holdings there it has yet to find are missing from every total.
   */
  readonly looking: readonly string[];
  /** Every holding as read, including Cash. */
  readonly holdings: readonly Holding[];
  /** Every non-cash holding, plus cash held for open orders. */
  readonly assets: PortfolioBucket;
  readonly cash: PortfolioBucket;
  /**
   * Money sent across to another network or a venue's account that hasn't landed
   * yet: no balance shows it until it does, so it is counted in the total here.
   */
  readonly onTheWay: {
    readonly usdValue: string;
    readonly moves: readonly OnItsWay[];
  };
}

/** One move still on its way: its action, and what lands where ("$29.00 on Arbitrum"). */
export interface OnItsWay {
  readonly actionId: string;
  readonly lands: string;
  readonly usdValue: string;
}

/**
 * What a reading keeps of each holding it read: enough to price it again
 * between readings, by its price feed, as the perp or outcome its chain and
 * instrument name, or as cash.
 */
export type ReadingHolding = Pick<
  Holding,
  "chain" | "instrument" | "priceId" | "quantity" | "decimals" | "usdValue" | "cash" | "short"
> & {
  /** Its price as it was read, from its shared feed (see priceKey), when one answered. */
  readonly price?: number;
};

const SHARED_READ_MS = 10_000;

/** A live read kept for screens, with the live prices of what it held as it was read (see livePrices). */
interface SharedRead {
  readonly at: number;
  readonly read: Promise<Portfolio>;
  readonly prices: Promise<Map<string, number>>;
}

let shared: SharedRead | null = null;
onForget(() => {
  shared = null;
});

/**
 * One live read every few seconds, shared by whatever asks within it:
 * screens and proposal checks of the cash and holdings that pay for them.
 * A read begun before a move finished shows the money as it was, so it is
 * not shared on (see sharedRead).
 */
export async function readPortfolioShared(): Promise<Portfolio> {
  return (await sharedRead()).read;
}

function liveShared(): SharedRead {
  const now = Date.now();
  if (shared && now - shared.at < SHARED_READ_MS) return shared;
  const read = readPortfolio();
  const entry = {
    at: now,
    read,
    prices: read.then(
      (portfolio) => livePrices(priceKeys(portfolio.holdings)),
      () => new Map<string, number>(),
    ),
  };
  shared = entry;
  read.catch(() => {
    if (shared === entry) shared = null;
  });
  return entry;
}

/**
 * The shared live read, let go of first when something has changed what is
 * held since it began (see outdated). The screens read again as a move lands,
 * and the agent is woken to plan its next one, both within seconds of a read
 * begun before it finished: shared on, that read would show a new holding as
 * missing and spent cash as still there.
 */
async function sharedRead(): Promise<SharedRead> {
  const kept = shared;
  if (kept && Date.now() - kept.at < SHARED_READ_MS) {
    const read = await kept.read.catch(() => null);
    if (read && (await outdated(read)) && shared === kept) shared = null;
  }
  return liveShared();
}

/**
 * The portfolio as a screen polled every minute shows it: the last live read
 * the screens shared, repriced at live shared prices, while it stands (see
 * readStands); otherwise a fresh read. So a screen open all day reads the
 * venues every 15 minutes rather than every minute, and the moment Auni moves
 * money, or money lands, it reads them again and shows what is really held.
 * Nothing that decides anything uses this: it is an estimate.
 */
export async function portfolioNow(): Promise<Portfolio> {
  const kept = shared;
  if (kept && Date.now() - kept.at >= SHARED_READ_MS) {
    const read = await kept.read.catch(() => null);
    if (read && (await readStands(read))) {
      const [then, now] = await Promise.all([kept.prices, livePrices(priceKeys(read.holdings))]);
      return repriced(read, then, now);
    }
  }
  return (await sharedRead()).read;
}

/**
 * A read with each holding moved from the price it had as it was read to
 * the price now (see movedUsd), and every total summed again; one without
 * both prices holds its value.
 */
function repriced(
  read: Portfolio,
  then: ReadonlyMap<string, number>,
  now: ReadonlyMap<string, number>,
): Portfolio {
  const move = (holding: Holding): Holding => {
    const key = priceKey(holding);
    if (!key || holding.usdValue === null) return holding;
    const usd = movedUsd(
      Number(holding.usdValue),
      perpSize(holding),
      then.get(key) ?? null,
      now.get(key) ?? null,
    );
    return { ...holding, usdValue: centsToUsd(BigInt(Math.round(usd * 100))) };
  };
  const holdings = read.holdings.map(move);
  const assets = holdings.filter((holding) => !holding.cash || holding.heldForOrders);
  const cash = holdings.filter((holding) => holding.cash && !holding.heldForOrders);
  return {
    ...read,
    totalUsd: sumUsd([worthUsd(holdings), read.onTheWay.usdValue]),
    holdings,
    assets: { usdValue: worthUsd(assets), holdings: assets },
    cash: { usdValue: worthUsd(cash), holdings: cash },
  };
}

/**
 * How much of one holding a wallet holds now, read fresh from its chain, in
 * QUANTITY_DECIMALS units, so a sale can be written to whichever thread held
 * what it sold; null when it can't be read. What an account keeps outside the
 * wallet (an outcome share) is read from the account; a perp's trades are
 * split by its statement instead (see statements.ts).
 */
export async function heldNow(key: FillKey): Promise<bigint | null> {
  try {
    const wallets = await walletAddresses();
    const evm = wallets.evm as Address | null;
    const owner = accountOwning(key);
    const read =
      key.chain === "solana"
        ? wallets.solana && readSolanaWallet(wallets.solana, new Set([key.instrument]))
        : !evm
          ? undefined
          : ((owner && keptAt(owner.account, key.chain, evm)) ??
            readEvmWallet(
              chainIdOf(key.chain),
              evm,
              isAddress(key.instrument) ? [key.instrument] : [],
            ));
    if (!read) return null;
    const held = (await read).find((holding) => fillIdentity(holding) === fillIdentity(key));
    return held ? held.baseUnits * 10n ** BigInt(QUANTITY_DECIMALS - held.decimals) : 0n;
  } catch (error) {
    console.warn(`holding ${fillIdentity(key)} unreadable before a sale:`, error);
    return null;
  }
}

/**
 * The first moment from `at` a reading held each of these, moved then on
 * `chain`, by fillIdentity, as readPortfolio picks what to read: `at` for
 * what it always reads (a chain's own coin, its USDC and savings, where cash
 * is spent) or read by then, else when it began to, from a fill of it, an
 * arrival of it, or its beginning to count (see startCounting); an EVM
 * chain's own coin elsewhere from the first of any of those on that chain, as
 * the chain is read whole from then. Absent for one it doesn't read yet.
 */
export async function readFrom(
  chain: NetworkKey,
  at: Date,
  instruments: readonly string[],
): Promise<Map<string, Date>> {
  const always = (instrument: string) => readFromStart(chain, instrument);
  const tokens = instruments.filter((instrument) => !always(instrument));
  // An EVM chain's own coin is read with the chain, from the first thing anywhere on it.
  const withChain = isEvmChain(chain) && tokens.includes("native");
  const asked = (column: AnyColumn) => (withChain ? undefined : instrumentIn(column, tokens));
  const [bought, arrived, kept] = await Promise.all([
    db
      .select({ instrument: fills.instrument, since: min(fills.createdAt) })
      .from(fills)
      .where(and(eq(fills.chain, chain), asked(fills.instrument)))
      .groupBy(fills.instrument),
    db
      .select({ instrument: arrivals.instrument, since: min(arrivals.createdAt) })
      .from(arrivals)
      .where(
        and(eq(arrivals.chain, chain), gt(arrivals.baseUnits, "0"), asked(arrivals.instrument)),
      )
      .groupBy(arrivals.instrument),
    db
      .select({ instrument: otherTokens.instrument, since: otherTokens.keptAt })
      .from(otherTokens)
      .where(and(eq(otherTokens.chain, chain), asked(otherTokens.instrument))),
  ]);
  const began = new Map<string, number>();
  const begin = (key: string, since: Date) =>
    began.set(key, Math.min(began.get(key) ?? Infinity, since.getTime()));
  for (const { instrument, since } of [...bought, ...arrived, ...kept]) {
    if (!since) continue;
    begin(fillIdentity({ chain, instrument }), since);
    if (withChain) begin(fillIdentity({ chain, instrument: "native" }), since);
  }
  return new Map(
    instruments.flatMap((instrument) => {
      const key = fillIdentity({ chain, instrument });
      const since = always(instrument) ? -Infinity : began.get(key);
      return since === undefined ? [] : [[key, new Date(Math.max(since, at.getTime()))]];
    }),
  );
}

/**
 * Whether every read of the owner's wallet holds this, from the start: where cash is spent, the
 * chain's own coin, its USDC and savings. Any other is read from when it began to be (readFrom).
 */
export function readFromStart(chain: string, instrument: string): boolean {
  return (
    isCash(chain) &&
    (instrument.toLowerCase() === NETWORKS[chain].usdc.toLowerCase() ||
      (chain === "solana" ? instrument === "native" : !isWalletToken(chain, instrument)))
  );
}

/**
 * Everything the owner holds, read live from every venue. Each read may also
 * be kept as a reading (see saveReading), without slowing or failing it.
 */
export async function readPortfolio(): Promise<Portfolio> {
  const observedAt = new Date();
  const [wallets, everyFill, arrived] = await Promise.all([
    walletAddresses(),
    allFills(db),
    // Every token that came in and was recorded, so one bought elsewhere and sent here is
    // read too, and one counted since (see startCounting): never one only seen, as
    // anyone can send a token (see buckets.ts). What this reads decides when money moved
    // counts (see readFrom).
    db
      .selectDistinct({ chain: arrivals.chain, instrument: arrivals.instrument })
      .from(arrivals)
      .where(gt(arrivals.baseUnits, "0"))
      .union(
        db
          .select({ chain: otherTokens.chain, instrument: otherTokens.instrument })
          .from(otherTokens)
          .where(isNotNull(otherTokens.keptAt)),
      ),
  ]);

  const evm = wallets.evm as Address | null;
  // Where Auni spends cash is always read; any other EVM chain once something was bought or
  // arrived there, so each network Auni watches costs a read only once it is used.
  const heldTokens = new Map<string, Set<Address>>(EVM_CASH_KEYS.map((key) => [key, new Set()]));
  for (const fill of everyFill) {
    if (!isEvmPlace(fill.chain)) continue;
    const tokens = heldTokens.get(fill.chain) ?? new Set();
    heldTokens.set(fill.chain, tokens);
    if (!isWalletToken(fill.chain, fill.instrument)) continue;
    tokens.add(fill.instrument as Address);
  }
  // Solana's by the same rule: a mint bought, or recorded arriving, or kept.
  const solanaMints = new Set(
    everyFill.flatMap(({ chain, instrument }) => (chain === "solana" ? [instrument] : [])),
  );
  const arrivedTokens = new Map<string, Address[]>();
  for (const { chain, instrument } of arrived) {
    if (chain === "solana") solanaMints.add(instrument);
    if (!isEvmPlace(chain)) continue;
    if (!heldTokens.has(chain)) heldTokens.set(chain, new Set());
    if (!isWalletToken(chain, instrument)) continue;
    arrivedTokens.set(chain, [...(arrivedTokens.get(chain) ?? []), instrument as Address]);
  }

  // Each source by name, and the chain whose holdings it reads; an account's by its place.
  const sources: [string, string, () => Promise<RawHolding[]>][] = [];
  const accountPlaces: string[] = [];
  if (evm) {
    for (const [chain, tokens] of heldTokens) {
      const others = arrivedTokens.get(chain) ?? [];
      sources.push([
        chain,
        chain,
        async () =>
          readEvmWallet(
            chainIdOf(chain),
            evm,
            [...tokens],
            others,
            await namesOf(chain, [...tokens, ...others]),
          ),
      ]);
    }
    // What each account keeps for the owner outside their wallet, filed under its app: a
    // ledger whole, contracts a chain at a time, and savings a chain at a time, so one chain's
    // outage hides only its own.
    const filed = (venue: string, read: () => Promise<readonly AccountHolding[]>) => async () =>
      (await read()).map((holding) => ({ ...holding, venue }));
    for (const { about, account } of accounts()) {
      const { kept } = account;
      if ("wallet" in kept) continue;
      const reads =
        "ledger" in kept
          ? [{ chain: about.id, read: () => kept.ledger(evm) }]
          : kept.chains.map((chain) => ({ chain, read: () => kept.read(evm, chain) }));
      for (const { chain, read } of reads) {
        const place = placeOf(about.id, chain);
        accountPlaces.push(place);
        sources.push([place, chain, filed(about.id, read)]);
      }
    }
    for (const chain of EVM_CASH_KEYS)
      for (const { about, token } of savingsTokens(chain))
        sources.push([
          `${about.id} ${chain}`,
          chain,
          filed(about.id, () => readSavings(chain, token, evm)),
        ]);
  }
  if (wallets.solana) {
    const solana = wallets.solana;
    sources.push(["solana", "solana", () => readSolanaWallet(solana, solanaMints)]);
  }

  // Each move on its way is asked whether it has landed as balances are read, not by its last check.
  const [results, onItsWay, looking] = await Promise.all([
    Promise.allSettled(sources.map(([, , read]) => read())),
    onTheirWay(),
    stillLooking(wallets),
  ]);
  const failed = sources.filter(([name], index) => {
    const result = results[index];
    if (result?.status !== "rejected") return false;
    console.warn(`portfolio source ${name} unavailable:`, result.reason);
    return true;
  });
  const unavailable = failed.map(([name]) => name);
  const raw = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const { holdings, pricesRead } = await priceHoldings(
    raw.filter((holding) => holding.baseUnits > 0n),
  );

  // What this read found that Auni counts nothing of yet was there before it looked, and is
  // put in before anything reads what money made (see first-look.ts).
  const looked = await countFirstLook(
    holdings,
    accountPlaces.filter((place) => !unavailable.includes(place)),
    new Set([...everyFill, ...arrived].map(fillIdentity)),
  ).then(
    () => true,
    (error: unknown) => {
      console.warn("first look not kept; this read is kept as no reading:", error);
      return false;
    },
  );

  const portfolio = withFillCosts(
    buildPortfolio({
      observedAt,
      holdings,
      onItsWay,
      // Without prices every priced holding drops out of the totals, so the read is partial too.
      unavailable: pricesRead ? unavailable : [...unavailable, "prices"],
      looking,
    }),
    everyFill,
  );
  if (looked)
    void saveReading(portfolio).catch((error: unknown) =>
      console.error("reading not kept", error),
    );
  return portfolio;
}

/**
 * Prices every holding whose dollar value isn't already known, at the live
 * prices everyone shares: a wallet token an account owns and prices at that
 * account's own price (see Account.prices), every other token at the public
 * feeds' (see tokenPrices). `pricesRead` is false when a price couldn't be read, as
 * opposed to a coin that has none: a read missing a price it could have had
 * would show as a dip.
 */
export async function priceHoldings(
  raw: readonly RawHolding[],
): Promise<{ holdings: Holding[]; pricesRead: boolean }> {
  /**
   * Where a holding's price comes from (see priceKey): a wallet token its account prices by
   * that account, any other by its feed. What an account keeps outside the wallet comes valued.
   */
  const keyOf = (holding: RawHolding) =>
    (holding.venue === "wallet" && accountOwning(holding)?.account.prices
      ? priceKey(holding)
      : null) ?? (holding.priceId ? `token:${holding.priceId}` : null);
  const keys = [...new Set(raw.flatMap((holding) => keyOf(holding) ?? []))];
  // Unpriced holdings are still shown; they just add nothing to totals.
  const { prices, complete: pricesRead } = await pricesNow(keys);
  const unpriced = keys.filter((key) => !prices.has(key));
  if (pricesRead && unpriced.length > 0) console.warn(`no price for ${unpriced.join(", ")}`);
  const holdings = raw.map((holding): Holding => {
    const quantity = formatUnits(holding.baseUnits, holding.decimals);
    const key = keyOf(holding);
    const price = key === null ? undefined : prices.get(key);
    let usdValue: string | null = holding.usdValue ?? null;
    if (holding.cash && usdValue === null) {
      // Dollar tokens at par, to the cent below as any token's worth is, never a cent not held.
      usdValue = unitsUsd(holding.baseUnits, holding.decimals, 1);
    } else if (price !== undefined) {
      usdValue = unitsUsd(holding.pricedUnits ?? holding.baseUnits, holding.decimals, price);
    }
    return {
      venue: holding.venue,
      chain: holding.chain,
      instrument: holding.instrument,
      symbol: holding.symbol,
      quantity,
      decimals: holding.decimals,
      usdValue,
      cash: holding.cash,
      ...(holding.heldForOrders ? { heldForOrders: true } : {}),
      priceId: holding.priceId,
      ...(holding.short ? { short: true } : {}),
      ...(holding.leverage ? { leverage: holding.leverage } : {}),
      ...(holding.averageCostUsd ? { averageCostUsd: holding.averageCostUsd } : {}),
    };
  });
  return { holdings, pricesRead };
}
