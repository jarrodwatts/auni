import {
  NETWORK_KEYS,
  NETWORKS,
  otherTokensWireSchema,
  portfolioWireSchema,
  type DepositWire,
  type NetworkKey,
  type OtherTokensWire,
  type UsdcMoneyWire,
} from "@auni/shared";

import { requestCore } from "@/lib/core";

import { toHolding } from "./specialists";
import { dollarsToBaseUnits, usdc } from "./usdc";
import type { LooseHoldings } from "./views";

/** What the screens read of the account's money. */
export interface Portfolio {
  /** Everything core could read; a source it couldn't adds nothing. */
  readonly totalUsd: UsdcMoneyWire;
  /** Signed: what the money has made, net of money added or taken out. */
  readonly made: UsdcMoneyWire;
  /** Some source couldn't be read, so the total may be missing money. */
  readonly partial: boolean;
  /** Auni is still making its first look through a wallet, so money there may not show yet. */
  readonly looking: boolean;
  /** Every source read, every wallet looked through, and nothing in any of them. */
  readonly empty: boolean;
  /** Money outside every specialist: what one-off chats left behind, and idle cash. */
  readonly loose: LooseHoldings;
  /** Money sent in lately, newest first, for a screen waiting on it to see land. */
  readonly deposits: readonly DepositWire[];
}

/**
 * The account's money from core's GET /portfolio: its last live read at live
 * prices, read again once money lands. `depositExpected` has core look for
 * that money every time it's asked, rather than every 15 minutes.
 */
export async function getPortfolio(
  signal?: AbortSignal,
  depositExpected = false,
): Promise<Portfolio> {
  const body = portfolioWireSchema.parse(
    await requestCore(depositExpected ? "portfolio?deposit=1" : "portfolio", {
      method: "GET",
      signal,
    }),
  );
  const total = dollarsToBaseUnits(body.totalUsd);
  const partial = body.unavailable.length > 0;
  const looking = body.looking.length > 0;
  return {
    totalUsd: usdc(total),
    made: usdc(dollarsToBaseUnits(body.madeUsd)),
    partial,
    looking,
    empty: total === 0n && !partial && !looking,
    loose: {
      other: body.other.map(toHolding),
      cash: {
        id: "cash",
        name: "Cash",
        detail: "US dollars, ready to use",
        logoUrl: "/brand/tokens/usdc.svg",
        value: usdc(dollarsToBaseUnits(body.cashUsd)),
        // Cash holds its value.
        todayChangeBaseUnits: "0",
      },
      otherTokens: body.otherTokens,
    },
    deposits: body.deposits,
  };
}

/**
 * Their other tokens, by address, with what they hold and what it may be
 * worth: read only while the list is open, from core's GET /portfolio/other-tokens.
 */
export async function getOtherTokens(signal?: AbortSignal): Promise<OtherTokensWire["tokens"]> {
  const body = await requestCore("portfolio/other-tokens", { method: "GET", signal });
  return otherTokensWireSchema.parse(body).tokens;
}

/** Add: the token at this address is theirs, so Auni counts it from its next read. */
export async function addToken(token: {
  readonly network: NetworkKey;
  readonly address: string;
}): Promise<void> {
  await requestCore("portfolio/other-tokens", { method: "POST", body: JSON.stringify(token) });
}

/** A network a person can send any token in on, with the address that receives it there. */
export interface DepositNetwork {
  readonly key: NetworkKey;
  readonly networkName: string;
  readonly logo: string;
  /** The EVM chain id a wallet reads from the QR code; null on Solana. */
  readonly chainId: number | null;
  readonly address: string;
}

function deposit(key: NetworkKey, address: string): DepositNetwork {
  const { name, logo, viem } = NETWORKS[key];
  return { key, networkName: name, logo, chainId: viem?.id ?? null, address };
}

/**
 * Where money can arrive from another wallet or exchange. The EVM networks
 * share one address; Solana has its own, so it is offered only once that
 * wallet exists.
 */
export function depositNetworks(wallets: {
  readonly evm: string | null;
  readonly solana: string | null;
}): readonly DepositNetwork[] {
  return NETWORK_KEYS.flatMap((key) => {
    const address = key === "solana" ? wallets.solana : wallets.evm;
    return address ? [deposit(key, address)] : [];
  });
}
