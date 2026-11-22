import { and, arrayOverlaps, asc, eq, isNotNull, isNull } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import { fills, threads, otherTokens } from "../db/schema.ts";
import { fillIdentity, instrumentIn } from "./fill-key.ts";
import { shortAddress } from "./format.ts";
import { listings, type Unreadable } from "./recognised.ts";

/**
 * Every token in the wallets is in exactly one bucket, decided here and
 * read by every place that shows, counts, tells or names one:
 *
 *   yours       Auni bought it for them, it landed counted (the deposit they
 *               said they'd send among them, by its address, never a name:
 *               see yoursOf), they added it or set Auni to trade it, or
 *               Auni came to recognise it (see startCounting in
 *               other-tokens.ts): once counted, always, as the money put
 *               in it counts it
 *   recognised  on a list Auni trusts (see recognised.ts)
 *   other       anything else: anyone can send a token, and price it from a
 *               pool they seeded, so it costs one row (see seeTokens) and is
 *               never priced, counted, named or told until it is yours or
 *               recognised
 *
 * A token is named by its bucket too (see tokenName).
 */
type Bucket = "yours" | "recognised" | "other";

export interface Sorted {
  readonly bucket: Bucket;
  /** What its listing calls it, if one does (see Listing). */
  readonly listed: string | null;
}

/**
 * An instrument as other_tokens keeps it, one row a token: an EVM address
 * lowercased, a Solana mint as it is, as reading one needs its case. Found
 * by instrumentIn, as case never matters.
 */
export function keptAs(chain: string, instrument: string): string {
  return chain === "solana" ? instrument : instrument.toLowerCase();
}

/**
 * Each of these tokens on `chain` sorted into its bucket, by
 * fillIdentity. Throws while a list it needs can't be read (see listings),
 * unless `unreadable` says otherwise.
 */
export async function sortTokens(
  chain: string,
  instruments: readonly string[],
  unreadable: Unreadable = "throw",
): Promise<Map<string, Sorted>> {
  if (instruments.length === 0) return new Map();
  const [theirs, listed] = await Promise.all([
    yoursOf(chain, instruments),
    listings(chain, instruments, unreadable),
  ]);
  return new Map(
    instruments.map((instrument) => {
      const key = fillIdentity({ chain, instrument });
      const listing = listed.get(key);
      const bucket: Bucket = theirs.has(key)
        ? "yours"
        : listing?.recognised
          ? "recognised"
          : "other";
      return [key, { bucket, listed: listing?.symbol ?? null }];
    }),
  );
}

/**
 * Those of `items` whose token on `chain` isn't Other, and
 * each token's bucket (see sortTokens); each Other one that came in is noted
 * as seen (see seeTokens). One whose token `instrument` can't name counts, as
 * nothing tells it Other. Throws while a list it needs can't be read, as
 * passing a token by would pass its deposits by for good.
 */
export async function notOther<T>(
  chain: string,
  items: readonly T[],
  of: {
    readonly instrument: (item: T) => string | null;
    readonly cameIn: (item: T) => boolean;
  },
): Promise<{ counted: T[]; sorted: Map<string, Sorted> }> {
  const sorted = await sortTokens(chain, [
    ...new Set(items.flatMap((item) => of.instrument(item) ?? [])),
  ]);
  const other = (item: T) => {
    const instrument = of.instrument(item);
    return (
      instrument !== null && sorted.get(fillIdentity({ chain, instrument }))?.bucket === "other"
    );
  };
  await seeTokens(
    db,
    chain,
    items.flatMap((item) => (other(item) && of.cameIn(item) ? [of.instrument(item)!] : [])),
  );
  return { counted: items.filter((item) => !other(item)), sorted };
}

/**
 * Which of these are theirs: bought, kept, or named by a deposit card of
 * theirs, by its network and address, so a token calling itself by the name
 * they gave is never taken for it.
 */
async function yoursOf(chain: string, instruments: readonly string[]): Promise<Set<string>> {
  const wanted = instruments.map((instrument) => fillIdentity({ chain, instrument }));
  const [bought, kept, named] = await Promise.all([
    db
      .selectDistinct({ instrument: fills.instrument })
      .from(fills)
      .where(and(eq(fills.chain, chain), instrumentIn(fills.instrument, instruments))),
    db
      .select({ instrument: otherTokens.instrument })
      .from(otherTokens)
      .where(
        and(
          eq(otherTokens.chain, chain),
          isNotNull(otherTokens.keptAt),
          instrumentIn(otherTokens.instrument, instruments),
        ),
      ),
    db
      .select({ tokens: threads.expectedTokens })
      .from(threads)
      .where(arrayOverlaps(threads.expectedTokens, wanted)),
  ]);
  const expected = new Set(named.flatMap(({ tokens }) => tokens));
  return new Set([
    ...[...bought, ...kept].map(({ instrument }) => fillIdentity({ chain, instrument })),
    ...wanted.filter((key) => expected.has(key)),
  ]);
}

/**
 * Notes once that each of these Other tokens came into their wallet: the one
 * row an Other token costs, which is how they find it to add (see
 * listOtherTokens). Seeing one again changes nothing.
 */
export async function seeTokens(
  q: Pick<Tx, "insert">,
  chain: string,
  instruments: readonly string[],
): Promise<void> {
  if (instruments.length === 0) return;
  await q
    .insert(otherTokens)
    .values(
      [...new Set(instruments.map((instrument) => keptAs(chain, instrument)))].map(
        (instrument) => ({ chain, instrument }),
      ),
    )
    .onConflictDoNothing();
}

/** A token seen in their wallets, never made theirs: what may be Other now. */
export interface Seen {
  readonly chain: string;
  readonly instrument: string;
}

/** Every token of theirs only seen, first seen first; those seen at once by network and address. */
export function seenTokens(): Promise<Seen[]> {
  return db
    .select({ chain: otherTokens.chain, instrument: otherTokens.instrument })
    .from(otherTokens)
    .where(isNull(otherTokens.keptAt))
    .orderBy(asc(otherTokens.seenAt), asc(otherTokens.chain), asc(otherTokens.instrument));
}

/** Each of these sorted into its bucket, every chain's at once (see sortTokens). */
export async function sortSeen<T extends Seen>(
  seen: readonly T[],
): Promise<(T & { readonly sorted: Sorted })[]> {
  const byChain = Map.groupBy(seen, ({ chain }) => chain);
  const sorted = new Map(
    (
      await Promise.all(
        [...byChain].map(async ([chain, on]) => [
          ...(await sortTokens(
            chain,
            on.map(({ instrument }) => instrument),
          )),
        ]),
      )
    ).flat(),
  );
  return seen.flatMap((one) => {
    const found = sorted.get(fillIdentity(one));
    return found ? [{ ...one, sorted: found }] : [];
  });
}

/** The Other tokens in their wallets, as seen arriving, first seen first. */
export async function listOtherTokens(): Promise<Seen[]> {
  const sorted = await sortSeen(await seenTokens());
  return sorted.filter(({ sorted: { bucket } }) => bucket === "other");
}

/** The longest symbol shown, in characters: a ticker, not a sentence. */
const NAME_MAX = 24;

/** What can't be seen, or reorders or hides what follows it: controls, format marks, combining marks. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Mn}\p{Me}\p{Zl}\p{Zp}]/gu;

/**
 * A name a token's maker chose, as Auni shows it: what can't be seen
 * stripped, spaces collapsed and the length capped; null when nothing is
 * left. Still the maker's words, so the agent reads it fenced as data.
 */
export function cleanName(raw: string, most = NAME_MAX): string | null {
  const name = Array.from(raw.replace(/\s+/gu, " ").replace(UNSEEN, "").trim())
    .slice(0, most)
    .join("")
    .trim();
  return name === "" ? null : name;
}

/**
 * A token's symbol by its bucket: a recognised one as its listing names it;
 * one of theirs by the symbol its listing or its own contract (`own`) gives
 * it; anything else, and any name left empty, by its short address. Where a
 * listing's symbol is the contract's own in other letters (a list that
 * capitalises every symbol: "XAUT0" for "XAUt0"), the contract's own is kept.
 */
export function tokenName(
  key: { readonly chain: string; readonly instrument: string },
  sorted: Sorted | undefined,
  own?: string | null,
): string {
  const listed =
    sorted?.listed && own?.toLowerCase() === sorted.listed.toLowerCase() ? own : sorted?.listed;
  const named =
    sorted?.bucket === "recognised" ? listed : sorted?.bucket === "yours" ? (listed ?? own) : null;
  return (named && cleanName(named)) ?? shortAddress(key.instrument);
}
