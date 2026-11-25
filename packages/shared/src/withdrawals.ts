import { z } from "zod";

import { actionWireSchema } from "./action.ts";
import { dollarsSchema } from "./money.ts";
import type { CashKey } from "./networks.ts";

/** Where a withdrawal can land: every chain cash is spent on, Base first since Coinbase takes USDC on Base natively. */
export const WITHDRAW_NETWORKS = [
  "base",
  "solana",
  "arbitrum",
  "monad",
  "polygon",
] as const satisfies readonly CashKey[];
export type WithdrawNetwork = (typeof WITHDRAW_NETWORKS)[number];

/**
 * `GET /withdrawals/cash`: the owner's cash as the portfolio's Cash counts it, the part in their
 * own wallet that a withdrawal sends, where the rest is, the most one withdrawal sends to each
 * network, and the places their last few withdrawals went, newest first, to pick again.
 */
export const withdrawCashWireSchema = z.object({
  cashUsd: dollarsSchema,
  walletUsd: dollarsSchema,
  /** Cash kept at an app (savings, a venue's own cash), by the app's name, largest first. */
  elsewhere: z.array(z.object({ name: z.string(), usdValue: dollarsSchema })),
  maxUsd: z.record(z.enum(WITHDRAW_NETWORKS), dollarsSchema),
  recent: z.array(
    z.object({
      address: z.string(),
      network: z.enum(WITHDRAW_NETWORKS),
      destination: z.enum(["exchange", "wallet"]).nullable(),
      at: z.iso.datetime(),
    }),
  ),
});
export type WithdrawCashWire = z.infer<typeof withdrawCashWireSchema>;

/** A withdrawal as core recorded it, with what the confirm step must show beside it. */
export const withdrawalWireSchema = z.object({
  action: actionWireSchema,
  review: z.object({
    /** The full destination address. */
    address: z.string(),
    network: z.enum(WITHDRAW_NETWORKS),
    /** What the owner said the address is, their exchange or their own wallet; null when they didn't say. */
    destination: z.enum(["exchange", "wallet"]).nullable(),
    /** A first withdrawal to it takes proof the owner is at the computer. */
    newAddress: z.boolean(),
    /** A past destination this one looks like but isn't. */
    lookalike: z.string().nullable(),
  }),
});
export type WithdrawalWire = z.infer<typeof withdrawalWireSchema>;
