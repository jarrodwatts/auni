import { erc20Abi, type Address } from "viem";

import { publicClient } from "../../money/chains.ts";
import { QUANTITY_DECIMALS } from "../../money/fill-key.ts";
import { outcomeKey } from "./keys.ts";
import { heldLabel, unitUsd } from "../../money/format.ts";
import type { Holding } from "../../money/portfolio.ts";
import { centsToUsd, usdToCents } from "../../money/usd.ts";
import type { HoldingFace, AccountHolding } from "../contract.ts";
import { CONTRACTS, dataRows } from "./http.ts";
import about from "./about.ts";
import { sharesContract } from "./markets.ts";
import { toMicros } from "./orders.ts";
import { depositWallet, heldShares } from "./wallet.ts";

/** The tokens its collateral is held as, each redeeming at $1. */
export const COLLATERAL = [CONTRACTS.pusd, CONTRACTS.usdce, CONTRACTS.usdc];

/** Positions and collateral live in the owner's Polymarket deposit wallet, not the EOA. */
export async function readPolymarket(owner: Address): Promise<AccountHolding[]> {
  const polygon = publicClient("polygon");
  const { address: wallet } = await depositWallet(owner);
  const [collateral, positions] = await Promise.all([
    Promise.all(
      COLLATERAL.map((token) =>
        polygon.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        }),
      ),
    ),
    readPolymarketPositions(wallet),
  ]);
  return [
    {
      chain: "polygon",
      instrument: "collateral",
      symbol: "USDC",
      // Every Polymarket collateral token has six decimals and redeems at $1.
      baseUnits: collateral.reduce((sum, balance) => sum + balance, 0n),
      decimals: 6,
      priceId: null,
      cash: true,
    },
    ...positions,
  ];
}

/**
 * Open positions, including won ones not yet redeemed, but never one its market resolved against,
 * worth nothing for good (see lostForGood). Archived markets and positions under the data API's
 * 0.1-share default floor are asked for too, since both are still money in the wallet.
 *
 * The data API says which outcomes the wallet holds, their names and their prices, but it is an
 * index that lags the chain: for a while after a sale it still lists the shares sold, beside the
 * cash the sale paid, which the chain already shows. So how many shares are held is read from
 * the chain, and an outcome the chain says is all sold is left out.
 */
async function readPolymarketPositions(wallet: Address): Promise<AccountHolding[]> {
  const listed = (await listedPositions(wallet)).filter((position) => !lostForGood(position));
  const held = await Promise.all(
    listed.map(({ token_id }) =>
      heldShares(
        { address: wallet, deployed: true },
        sharesContract(BigInt(token_id)),
        BigInt(token_id),
      ),
    ),
  );
  return listed.flatMap((position, index) => {
    const micros = held[index]!;
    if (micros === 0n) return [];
    const listedMicros = toMicros(position.current_size);
    const listedCents = usdToCents(position.current_value.toFixed(6));
    return [
      {
        ...outcomeKey(position.token_id),
        symbol: `${position.title}: ${position.outcome}`.slice(0, 120),
        // Shares have six decimals on chain; a holding counts them in QUANTITY_DECIMALS.
        baseUnits: micros * 10n ** BigInt(QUANTITY_DECIMALS - 6),
        decimals: QUANTITY_DECIMALS,
        priceId: null,
        // Worth what the data API prices a share at, for the shares the chain holds.
        ...(listedMicros > 0n
          ? { usdValue: centsToUsd((listedCents * micros) / listedMicros) }
          : {}),
        cash: false,
        ...(position.avg_price > 0 ? { averageCostUsd: unitUsd(position.avg_price) } : {}),
      },
    ];
  });
}

export interface ListedPosition {
  readonly token_id: string;
  readonly condition_id: string;
  readonly current_size: number;
  readonly current_value: number;
  readonly title: string;
  readonly outcome: string;
  readonly avg_price: number;
  /** Its market has resolved, so its shares can be redeemed, for what they pay. */
  readonly redeemable: boolean;
}

/**
 * Whether its market resolved against it: redeemable, for nothing. Polymarket redeems only
 * shares that pay, so these sit in the wallet for good, worth nothing (see polymarketLosses).
 */
export function lostForGood(position: ListedPosition): boolean {
  return position.redeemable && position.current_value === 0;
}

/** The outcomes the data API lists for the wallet, every page of them. */
export function listedPositions(wallet: Address): Promise<ListedPosition[]> {
  return dataRows<ListedPosition>("/v2/positions", {
    user: wallet,
    filter_type: "TOKENS",
    filter_amount: "0",
    include_archived: "true",
  });
}

/**
 * An outcome share as the portfolio shows it. A share is named "<market>: <outcome>" as it is
 * read (see readPolymarketPositions), which reads as the market over the outcome and how many are held.
 */
export async function outcomeFace(holding: Holding): Promise<HoldingFace> {
  const split = holding.symbol.lastIndexOf(": ");
  const title = split > 0 ? holding.symbol.slice(0, split) : holding.symbol;
  const outcome = split > 0 ? holding.symbol.slice(split + 2) : "";
  return {
    name: title,
    detail: `${outcome ? `${outcome}, ` : ""}${heldLabel(holding.quantity)} shares on ${about.name}`,
    logoUrl: null,
  };
}
