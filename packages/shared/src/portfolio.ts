import { z } from "zod";

import { holdingWireSchema } from "./specialist.ts";
import { dollarsSchema } from "./money.ts";
import { NETWORK_KEYS } from "./networks.ts";

/**
 * Money sent in from another wallet or exchange that Auni recorded, worth a
 * cent or more: what a screen waiting on a deposit sees land, and says.
 */
const depositWireSchema = z.object({
  /** The arrival's own id, so a screen can tell one it hasn't seen before. */
  id: z.string(),
  /** What arrived, as the portfolio names it: "ETH". */
  symbol: z.string(),
  /** How much of it, in whole units: "0.081". */
  amount: z.string(),
  /** Where it arrived, as people read it: "Base". */
  network: z.string(),
  /** Its dollars when it arrived. */
  usdValue: dollarsSchema,
});

export type DepositWire = z.infer<typeof depositWireSchema>;

/** Core's GET /portfolio: the live total, and the money outside every specialist. */
export const portfolioWireSchema = z.object({
  /** Everything read; a source named in `unavailable` adds nothing to it. */
  totalUsd: dollarsSchema,
  /** Signed: what it has made, net of money added or taken out (see GET /portfolio/history). */
  madeUsd: dollarsSchema,
  /** Sources that could not be read this time. */
  unavailable: z.array(z.string()),
  /**
   * The networks of the owner's wallets Auni is still making its first look at: money there
   * may not show in the total yet.
   */
  looking: z.array(z.string()),
  /** Money on its way between networks first ("On the way"), then what one-off chats bought, largest first. */
  other: z.array(holdingWireSchema),
  /** Idle dollars outside every specialist. */
  cashUsd: dollarsSchema,
  /**
   * How many tokens in their wallets Auni neither recognises nor was told are
   * theirs: never counted, priced or named, and listed only when they open them
   * (see otherTokensWireSchema).
   */
  otherTokens: z.number().int().min(0),
  /** The latest few deposits recorded in the last hour, newest first. */
  deposits: z.array(depositWireSchema),
});

/**
 * Core's GET /portfolio/other-tokens: each token counted in `otherTokens`, by
 * its address alone, since its name is its maker's to choose, with what the
 * wallet holds of it and what it may be worth, read only as they open the list.
 */
export const otherTokensWireSchema = z.object({
  tokens: z.array(
    z.object({
      network: z.enum(NETWORK_KEYS),
      address: z.string(),
      /** Whole units held now: "1200.5"; null when the chain couldn't be read. */
      amount: z.string().nullable(),
      /** What a price feed says it's worth; null with no price, which anyone's pool can set anyway. */
      usdValue: dollarsSchema.nullable(),
    }),
  ),
});
export type OtherTokensWire = z.infer<typeof otherTokensWireSchema>;
