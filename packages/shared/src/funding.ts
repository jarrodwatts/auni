import { z } from "zod";

import { EVM_CHAIN_KEYS, NETWORKS, type EvmChainKey } from "./networks.ts";

// Paying into Auni from a browser wallet: core asks its pay-in app for a quote from USDC on
// another chain to USDC on Monad, paid to the wallet's own address (money/pay-in.ts in core), and
// the browser wallet sends each step itself.

/**
 * The MON Add money asks for beside the USDC, for the wallet's network fees on Monad: dozens of
 * moves, at the 0.16 MON a stock buy cost in November 2026 (when 10 MON was about 17 cents). A card
 * buys more with a little of the USDC as it runs low (money/fee-coin.ts in core).
 */
export const START_MON = 10;

/** The chains a browser wallet can pay from: every EVM chain with Circle's USDC, but Monad. */
export const FUNDING_FROM: readonly EvmChainKey[] = EVM_CHAIN_KEYS.filter(
  (key) => key !== "monad" && NETWORKS[key].usdc !== null,
);

/** `POST /funding/quote`. Core alone says who is paid: always the wallet's own address. */
export const fundingQuoteRequestSchema = z.strictObject({
  chainId: z.number().int().positive(),
  /** Dollars of USDC, as typed: "20", "12.5". */
  amountUsdc: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/u),
  /** The browser wallet that pays. */
  user: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
});
export type FundingQuoteRequest = z.infer<typeof fundingQuoteRequestSchema>;

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/u);

/** A quote, checked by core, as the browser wallet sends it: each step in order, then status. */
export const fundingQuoteWireSchema = z.object({
  /** The service that carries it, by name ("Relay"), for what the owner reads of it. */
  by: z.string(),
  requestId: hexSchema,
  steps: z.array(
    z.object({
      id: z.enum(["approve", "deposit"]),
      description: z.string(),
      chainId: z.number(),
      to: hexSchema,
      data: hexSchema,
    }),
  ),
  /** USDC Auni receives on Monad, in dollars. */
  receiveUsdc: z.string(),
  /** MON that comes with it for network fees, when the wallet held under 1 MON; else null. */
  receiveMon: z.string().nullable(),
  /** About how long it takes, in seconds. */
  seconds: z.number().nullable(),
});
export type FundingQuoteWire = z.infer<typeof fundingQuoteWireSchema>;

/** `GET /funding/status/:requestId`. */
export const fundingStatusWireSchema = z.object({
  status: z.enum(["pending", "success", "refunded", "failed"]),
});
export type FundingStatusWire = z.infer<typeof fundingStatusWireSchema>;
