import {
  isEvmChain,
  NETWORKS,
  type EvmChainKey,
  type NetworkKey,
  type OtherTokensWire,
} from "@auni/shared";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { erc20Abi, isAddress, type Address } from "viem";

import { lockOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { arrivals, fills, otherTokens } from "../db/schema.ts";
import {
  keptAs,
  listOtherTokens,
  seenTokens,
  sortSeen,
  tokenName,
  type Seen,
  type Sorted,
} from "./buckets.ts";
import { chainIdOf, evmClient } from "./chains.ts";
import { isPlainCash } from "./coins.ts";
import { evmTokenKey, fillIdentity, instrumentIn, type FillKey } from "./fill-key.ts";
import { pricesNow, walletPriceKey } from "./history.ts";
import { tellRecognised as tellThem, type Recognised } from "./news.ts";
import { told } from "./told.ts";
import { readTokens, solanaTokens } from "./chain-holdings.ts";
import { evmXStocks } from "./swaps/xstocks.ts";
import { feedListed } from "./token-feeds.ts";
import { formatUnits, unitsUsd } from "./usd.ts";
import { readFromStart } from "./portfolio.ts";
import { walletAddresses } from "./wallets.ts";

/**
 * Tokens in the owner's wallets that are Other (see buckets.ts): read and valued
 * only while they look at them, made theirs at their word, and told of once
 * Auni comes to recognise one. Never named: their makers choose the names.
 * And how any token begins to count (see startCounting).
 */

interface Token {
  readonly chain: string;
  readonly instrument: string;
}

/** What one holds of a token now, in base units, as of a block, or Solana slot. */
interface Held {
  readonly units: bigint;
  /** The base units its price counts, where they aren't its balance: an xStock's shares. */
  readonly pricedUnits?: bigint;
  readonly decimals: number;
  readonly block: number;
}

/**
 * What their wallet on `chain` holds now of each of these, by fillIdentity,
 * each as of the block it was read at, so what moved by then is known to be
 * in it (see arrivalFlows in made.ts), and that block; one a token won't say
 * is absent, as of `block`. Throws while the chain, or their wallet on it,
 * can't be read.
 */
async function heldOn(
  wallets: Awaited<ReturnType<typeof walletAddresses>>,
  chain: string,
  instruments: readonly string[],
): Promise<{ block: number; held: Map<string, Held> }> {
  if (chain === "solana") {
    if (!wallets.solana) throw new Error("no Solana wallet to read");
    const { slot, byMint } = await solanaTokens(wallets.solana);
    return {
      block: slot,
      held: new Map(
        instruments.map((instrument) => {
          // A mint with no token account, gone or never made, is none of it held.
          const one = byMint.get(instrument) ?? { amount: 0n, decimals: 0, slot };
          return [
            fillIdentity({ chain, instrument }),
            { units: one.amount, decimals: one.decimals, block: one.slot },
          ];
        }),
      ),
    };
  }
  if (!wallets.evm) throw new Error(`no EVM wallet to read on ${chain}`);
  const owner = wallets.evm as Address;
  const client = evmClient(chainIdOf(chain));
  const blockNumber = await client.getBlockNumber();
  const block = Number(blockNumber);
  const [coin, tokens] = await Promise.all([
    // A network's own coin is no contract, so is read as a balance.
    instruments.includes("native") ? client.getBalance({ address: owner, blockNumber }) : undefined,
    readTokens(
      client,
      owner,
      instruments.filter((instrument) => instrument !== "native") as Address[],
      { strict: false, blockNumber },
    ),
  ]);
  const held = new Map<string, Held>(
    tokens.map(({ token, balance, pricedUnits, decimals }) => [
      fillIdentity({ chain, instrument: token }),
      { units: balance, pricedUnits, decimals, block },
    ]),
  );
  if (coin !== undefined) {
    const { decimals } = NETWORKS[chain as NetworkKey].coin;
    held.set(fillIdentity({ chain, instrument: "native" }), { units: coin, decimals, block });
  }
  return { block, held };
}

/** Where a token's price comes from: the account that owns and prices it, else the public feeds; null at a dollar a unit. */
const priceKeyOf = ({ chain, instrument }: Token) =>
  walletPriceKey(chain as NetworkKey, instrument);

/** What one holds of a token now, and what a price feed says that's worth. */
interface Worth {
  /** Whole units: "1200.5"; null where its chain couldn't be read, or it won't say. */
  readonly amount: string | null;
  /** Null with no price, or where unread. */
  readonly usdValue: string | null;
}

/** What `held` says one holds of `token`, and what `prices` say that's worth. */
function worth(
  token: Token,
  held: ReadonlyMap<string, Held>,
  prices: ReadonlyMap<string, number>,
): Worth {
  const one = held.get(fillIdentity(token));
  const key = priceKeyOf(token);
  const price = key === null ? 1 : prices.get(key);
  return {
    amount: one ? formatUnits(one.units, one.decimals) : null,
    usdValue:
      one && price !== undefined
        ? unitsUsd(one.pricedUnits ?? one.units, one.decimals, price)
        : null,
  };
}

/**
 * Their Other tokens as they open the list: each by network and address,
 * with what they hold of it and, if `priced`, what a price feed says that's
 * worth, read now and never kept; a network that can't be read leaves its
 * own unread.
 */
export async function readOtherTokens(priced = true): Promise<OtherTokensWire> {
  const tokens = await listOtherTokens();
  if (tokens.length === 0) return { tokens: [] };
  const wallets = await walletAddresses();
  const [reads, { prices }] = await Promise.all([
    Promise.allSettled(
      [...Map.groupBy(tokens, ({ chain }) => chain)].map(([chain, on]) =>
        heldOn(
          wallets,
          chain,
          on.map(({ instrument }) => instrument),
        ),
      ),
    ),
    priced
      ? pricesNow(tokens.flatMap((token) => priceKeyOf(token) ?? []))
      : { prices: new Map<string, number>() },
  ]);
  const held = new Map(
    reads.flatMap((read) => (read.status === "fulfilled" ? [...read.value.held] : [])),
  );
  return {
    tokens: tokens.map((token) => ({
      network: token.chain as NetworkKey,
      address: token.instrument,
      ...worth(token, held, prices),
    })),
  };
}

/**
 * A token as other_tokens keeps it, if `address` names one on `network`: an
 * EVM contract lowercased, or a Solana mint; null for anything else.
 */
export function tokenOn(network: NetworkKey, address: string): string | null {
  const trimmed = address.trim();
  if (isEvmChain(network))
    return isAddress(trimmed) ? evmTokenKey(network, trimmed.toLowerCase()).instrument : null;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(trimmed) ? trimmed : null;
}

/**
 * Auni's first look at the EVM wallet on `chain` (see first-look.ts): what it held there before
 * Auni first swept it, a wallet brought in with money in it, or one used outside Auni. No plain
 * RPC lists a wallet's past, so the sweep finds only what moves from its first sweep on, and
 * Auni would never see money that was already there. So, once, every token Auni recognises
 * there is asked for (the network's own coin, its USDC and USDT, every token on a feed's list
 * for it, and every tokenized stock), and each the wallet holds any of begins to count, as
 * money put in (see startCounting). A token on no list can't be found this way: it shows once
 * it moves, or when the owner adds it. Throws while the chain, a list or a price can't be read,
 * so the sweep tries again, and the wallet there counts as still being looked at.
 */
export async function countWhatWasThere(chain: EvmChainKey, owner: Address): Promise<void> {
  const { usdc, usdt } = NETWORKS[chain];
  const [listed, stocks] = await Promise.all([feedListed(chain), evmXStocks()]);
  // A list names the coin's own token face too (Polygon's POL), which is the coin, read once.
  const tokens = [
    ...new Set(
      [usdc, usdt, ...listed.keys(), ...stocks].flatMap((token) =>
        token && isAddress(token) && evmTokenKey(chain, token).instrument !== "native"
          ? [token.toLowerCase() as Address]
          : [],
      ),
    ),
  ];
  const client = evmClient(chainIdOf(chain));
  const [coin, balances] = await Promise.all([
    client.getBalance({ address: owner }),
    client.multicall({
      contracts: tokens.map(
        (token) =>
          ({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as const,
      ),
      allowFailure: true,
      // A list holds thousands: some hundreds a call, not a dozen.
      batchSize: 50_000,
    }),
  ]);
  const held = tokens.filter((_, index) => {
    const read = balances[index];
    return read?.status === "success" && (read.result as bigint) > 0n;
  });
  await startCounting(chain, [...(coin > 0n ? ["native"] : []), ...held]);
}

/**
 * Makes the token at `address` on `network` theirs, at their word, counted
 * from now on (see startCounting); the token as kept, or null when `address`
 * names none there. Throws while it can't be valued.
 */
export async function addToken(network: NetworkKey, address: string): Promise<string | null> {
  const instrument = tokenOn(network, address);
  if (!instrument) return null;
  await startCounting(network, [instrument]);
  return instrument;
}

/**
 * Begins counting each token only seen in their wallets that Auni now
 * recognises (see recognised.ts), and so tells them of it (see
 * startCounting). Throws while a network can't be read, so the sweep
 * reports it and tries again; each other one begins all the same.
 */
export async function tellRecognised(): Promise<void> {
  const recognised = (await sortSeen(await seenTokens())).filter(
    ({ sorted }) => sorted.bucket === "recognised",
  );
  await startCountingEach(recognised, {
    sorted: new Map(recognised.map((one) => [fillIdentity(one), one.sorted])),
  });
}

/**
 * Begins counting each token in their wallet a move of Auni's trades, before
 * it runs (see startCounting): the move's fills count only what it buys or
 * sells, so what the wallet held of it already counts as money put in, never
 * as made, whether Auni saw it arrive or it was there before Auni was (a
 * wallet brought in). A look made after the trade would count it as the trade
 * left it: a sweep can fail for hours while Auni trades there. Throws while
 * one can't be valued, so the move doesn't run.
 */
export async function countBeforeTrading(traded: readonly FillKey[]): Promise<void> {
  await startCountingEach(
    traded.filter(
      ({ chain, instrument }) =>
        Object.hasOwn(NETWORKS, chain) &&
        (instrument === "native" || tokenOn(chain as NetworkKey, instrument) !== null),
    ),
  );
}

/** Begins counting each of these, every chain's at once (see startCounting). */
async function startCountingEach(
  seen: readonly Seen[],
  options: Parameters<typeof startCounting>[2] = {},
): Promise<void> {
  await Promise.all(
    [...Map.groupBy(seen, ({ chain }) => chain)].map(([chain, on]) =>
      startCounting(
        chain as NetworkKey,
        on.map(({ instrument }) => instrument),
        options,
      ),
    ),
  );
}

/**
 * Makes these tokens on `chain` count for them from now on, the one way a
 * wallet token begins to, whether Auni found it there when it first looked
 * (see first-look.ts), they added it, Auni came to recognise it or is about
 * to trade it (see countBeforeTrading), or money in it came or went from
 * outside. What their wallet holds of each is read at a block, or Solana
 * slot, and its worth then kept once as money put in (see keptUsd and
 * keptBlock in schema.ts): what moved there or before is in that worth and
 * counts in no arrival of it, and what moved after counts as its arrival
 * does, whichever is recorded first (see arrivalFlows in made.ts), so each
 * unit counts once and what they held before counts as nothing made. On an
 * EVM chain where cash isn't spent its own coin is looked at too, as the
 * portfolio begins to read the chain with its coin; where it is, every read
 * holds the coin, and the first is its look.
 *
 * One Auni counts already is left as it is: one begun before, and one it has
 * a record of moving (a fill, an arrival), which counts as it moved. So is
 * plain cash, which counts as what was put in (see madeUsd), and one never
 * seen that the wallet holds none of: what it gets later counts as it comes.
 *
 * One they held while it was Other that Auni now recognises, by `sorted`, is
 * told at that worth, if that's a cent or more, with how it got there (see
 * tellRecognised in news.ts). One theirs isn't, as what made it theirs was them: adding it, trading it,
 * or saying they'd send it, whose deposit is told. Throws while their wallet
 * there, or a price, can't be read, as counting a token unvalued would show
 * its worth as made.
 */
export async function startCounting(
  chain: NetworkKey,
  instruments: readonly string[],
  { sorted = new Map() }: { readonly sorted?: ReadonlyMap<string, Sorted> } = {},
): Promise<void> {
  // An EVM chain read from when it began to be is read with its own coin (see readFrom).
  const withCoin = isEvmChain(chain) && !readFromStart(chain, "native") && instruments.length > 0;
  const tokens = (await notCounted(chain, withCoin ? [...instruments, "native"] : instruments)).map(
    (instrument) => ({ chain, instrument }),
  );
  if (tokens.length === 0) return;
  const { block, held } = await heldOn(
    await walletAddresses(),
    chain,
    tokens.map(({ instrument }) => instrument),
  );
  const rows = await db
    .select({ instrument: otherTokens.instrument, keptAt: otherTokens.keptAt })
    .from(otherTokens)
    .where(
      and(
        eq(otherTokens.chain, chain),
        instrumentIn(
          otherTokens.instrument,
          tokens.map(({ instrument }) => instrument),
        ),
      ),
    );
  const seen = new Set(rows.map((row) => fillIdentity({ chain, instrument: row.instrument })));
  const holding = tokens.filter(
    (token) => seen.has(fillIdentity(token)) || (held.get(fillIdentity(token))?.units ?? 0n) > 0n,
  );
  if (holding.length === 0) return;
  const { prices, complete } = await pricesNow(holding.flatMap((token) => priceKeyOf(token) ?? []));
  if (!complete) throw new Error(`token prices unavailable to value tokens on ${chain}`);
  const valued = holding.map((token) => ({
    ...token,
    ...worth(token, held, prices),
    block: held.get(fillIdentity(token))?.block ?? block,
  }));
  await db.transaction(async (tx) => {
    // The owner's row, as recordArrivals takes it, so two at once begin a token, and tell it, once.
    await lockOwner(tx);
    const rows = await tx
      .select({ instrument: otherTokens.instrument, keptAt: otherTokens.keptAt })
      .from(otherTokens)
      .where(
        and(
          eq(otherTokens.chain, chain),
          instrumentIn(
            otherTokens.instrument,
            valued.map(({ instrument }) => instrument),
          ),
        ),
      );
    // Each as it was: absent if never seen, null if only seen, or when it began to count.
    const was = new Map(
      rows.map(({ instrument, keptAt }) => [fillIdentity({ chain, instrument }), keptAt]),
    );
    const begun = valued.filter((token) => !was.get(fillIdentity(token)));
    if (begun.length === 0) return;
    await tx
      .insert(otherTokens)
      .values(
        begun.map(({ instrument, usdValue, block }) => ({
          chain,
          instrument: keptAs(chain, instrument),
          keptAt: sql`now()`,
          keptUsd: usdValue,
          keptBlock: block,
        })),
      )
      .onConflictDoUpdate({
        target: [otherTokens.chain, otherTokens.instrument],
        set: {
          keptAt: sql`now()`,
          keptUsd: sql`excluded.kept_usd`,
          keptBlock: sql`excluded.kept_block`,
        },
        setWhere: isNull(otherTokens.keptAt),
      });
    await tellThem(
      tx,
      chain,
      begun.flatMap((token): Recognised[] => {
        const key = fillIdentity(token);
        const one = sorted.get(key);
        return was.has(key) && one?.bucket === "recognised" && token.amount !== null && told(token)
          ? [
              {
                instrument: token.instrument,
                name: tokenName(token, one),
                amount: token.amount,
                usdValue: token.usdValue!,
              },
            ]
          : [];
      }),
    );
  });
}

/**
 * Which of these on `chain` nothing counts yet: not plain cash, and none Auni began to count or
 * has a record of moving, in a fill or an arrival.
 */
async function notCounted(chain: NetworkKey, instruments: readonly string[]): Promise<string[]> {
  const asked = [
    ...new Map(
      instruments.flatMap((instrument) =>
        isPlainCash(chain, instrument) ? [] : [[fillIdentity({ chain, instrument }), instrument]],
      ),
    ).values(),
  ];
  if (asked.length === 0) return [];
  const [kept, filled, arrived] = await Promise.all([
    db
      .select({ instrument: otherTokens.instrument })
      .from(otherTokens)
      .where(
        and(
          eq(otherTokens.chain, chain),
          isNotNull(otherTokens.keptAt),
          instrumentIn(otherTokens.instrument, asked),
        ),
      ),
    db
      .selectDistinct({ instrument: fills.instrument })
      .from(fills)
      .where(and(eq(fills.chain, chain), instrumentIn(fills.instrument, asked))),
    db
      .selectDistinct({ instrument: arrivals.instrument })
      .from(arrivals)
      .where(and(eq(arrivals.chain, chain), instrumentIn(arrivals.instrument, asked))),
  ]);
  const counted = new Set(
    [...kept, ...filled, ...arrived].map(({ instrument }) => fillIdentity({ chain, instrument })),
  );
  return asked.filter((instrument) => !counted.has(fillIdentity({ chain, instrument })));
}
