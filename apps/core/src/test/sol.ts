import { NETWORKS } from "@auni/shared";

import type { SolTopUp } from "../money/sol-top-up.ts";

/**
 * What a card pins of the SOL it buys (money/fee-coin-said.ts): `usdc` of Monad's USDC sent to
 * the pay-in service, or of the wallet's Solana USDC swapped there.
 */
export function pinnedSol(usdc: string, how: "pay-in" | "swap" = "pay-in"): Record<string, string> {
  return {
    feeCoinOn: "solana",
    feeCoinFrom: how === "swap" ? "solana" : "monad",
    feeCoinToken: how === "swap" ? NETWORKS.solana.usdc : NETWORKS.monad.usdc,
    feeCoinAmount: usdc,
    feeCoinUsd: (Number(usdc) / 1e6).toFixed(2),
    feeCoinBy: how === "swap" ? "Jupiter" : "Relay",
  };
}

/** A top-up through the pay-in service: a dollar of Monad's USDC for SOL, its quote left out. */
export const RELAYED_SOL = {
  via: "pay-in",
  usdc: 1_000_000n,
  // What opening a USDC account is short from a wallet with no SOL: its rent, a signature and
  // the least a wallet keeps.
  lamports: 2_694_520n,
  spends: 0n,
  bought: {
    chain: "solana",
    from: "monad",
    token: NETWORKS.monad.usdc,
    amount: 1_000_000n,
    usd: 1,
    by: "Relay",
  },
} as SolTopUp;
