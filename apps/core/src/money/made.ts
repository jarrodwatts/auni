import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import { db } from "../db/client.ts";
import { arrivals, otherTokens } from "../db/schema.ts";
import { isPlainCash } from "./coins.ts";
import { fillIdentity, type FillKey } from "./fill-key.ts";
import { fillsWithLeverage, flowsFrom, type Flow } from "./flows.ts";
import { readFromStart } from "./portfolio.ts";
import { centsToUsd } from "./usd.ts";

/**
 * What money made, net of money added or taken out: a value, less its plain
 * cash, less the money moved into its holdings. Over a range, what was made
 * is the end's less the start's.
 *
 * Plain cash (USDC in a wallet or at a venue, or on its way between chains)
 * is worth just what was put in, so a deposit or a withdrawal, which moves it
 * alone, makes nothing. A buy moves money out of plain cash into a holding at
 * its cost, recorded as a fill, so only what the holding did since counts,
 * any venue's fee included. Savings is cash that earns: moving money into it is a
 * fill too, so its interest counts and the move doesn't. Anything else sent
 * in or out, like ETH from an exchange, is money put in or taken out at its
 * value as it moved, and a token that begins to count is put in at its worth
 * then (see arrivalFlows), so receiving it makes nothing either.
 *
 * A holding held without a price (`unpriced`, by fillIdentity) is in no
 * value, so the money moved into it is left out too: it has made nothing
 * that can be told, rather than lost all it cost. Once priced again, what it
 * did meanwhile counts.
 */
export function madeUsd(
  valueUsd: number,
  plainCashUsd: number,
  flows: readonly Flow[],
  at = Infinity,
  unpriced: ReadonlySet<string> = new Set(),
): string {
  const moved = flows.reduce(
    (sum, flow) =>
      flow.at <= at && !(flow.key !== undefined && unpriced.has(flow.key)) ? sum + flow.usd : sum,
    0,
  );
  return centsToUsd(BigInt(Math.round((valueUsd - plainCashUsd - moved) * 100)));
}

/** The holdings among these held without a price, by fillIdentity, for madeUsd. */
export function unpricedOf(
  holdings: readonly (FillKey & { readonly usdValue: string | null })[],
): Set<string> {
  return new Set(
    holdings.flatMap((holding) => (holding.usdValue === null ? [fillIdentity(holding)] : [])),
  );
}

/**
 * Money the owner's trades moved into holdings, and money that came in or
 * went out from outside Auni, oldest first.
 */
export async function walletFlows(): Promise<Flow[]> {
  const [traded, arrived] = await Promise.all([
    fillsWithLeverage().then(flowsFrom),
    arrivalFlows(),
  ]);
  return [...traded, ...arrived].toSorted((left, right) => left.at - right.at);
}

/**
 * A deposit or money sent out that Auni didn't send, of anything but plain
 * cash, as money put in or taken out at its value as it moved, from when a
 * reading held what moved (see countsFrom); and each holding that began to
 * count, what Auni first found already there included, at what it held then,
 * from then (see keptUsd, and first-look.ts), or from the start for what every
 * read of the wallet holds (see readFromStart): a reading before then held it.
 * A wallet token's worth was read at a block, so it holds whatever moved there or
 * before, recorded yet or not: only what moved after counts again, whichever
 * was recorded first. One with no price counts as nothing, as the portfolio
 * counts it.
 */
async function arrivalFlows(): Promise<Flow[]> {
  const [moved, kept] = await Promise.all([
    db
      .select({
        chain: arrivals.chain,
        instrument: arrivals.instrument,
        usdValue: arrivals.usdValue,
        countsFrom: arrivals.countsFrom,
      })
      .from(arrivals)
      .leftJoin(
        otherTokens,
        and(
          eq(otherTokens.chain, arrivals.chain),
          sql`lower(${otherTokens.instrument}) = lower(${arrivals.instrument})`,
        ),
      )
      .where(
        and(
          inArray(arrivals.kind, ["deposit", "external_out"]),
          isNotNull(arrivals.usdValue),
          or(isNull(otherTokens.keptBlock), gt(arrivals.block, otherTokens.keptBlock)),
        ),
      ),
    db
      .select({
        chain: otherTokens.chain,
        instrument: otherTokens.instrument,
        usdValue: otherTokens.keptUsd,
        keptAt: otherTokens.keptAt,
      })
      .from(otherTokens)
      .where(isNotNull(otherTokens.keptUsd)),
  ]);
  return [
    ...moved.flatMap((row) =>
      isPlainCash(row.chain, row.instrument)
        ? []
        : [{ at: row.countsFrom.getTime(), usd: Number(row.usdValue), key: fillIdentity(row) }],
    ),
    ...kept.map((row) => ({
      at: readFromStart(row.chain, row.instrument) ? 0 : row.keptAt!.getTime(),
      usd: Number(row.usdValue),
      key: fillIdentity(row),
    })),
  ];
}
