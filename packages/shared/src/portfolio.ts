import { z } from "zod";

import { dollarsSchema } from "./money.ts";
import { CASH_KEYS, NETWORK_KEYS } from "./networks.ts";
import { threadIdSchema } from "./shared.ts";

/** One holding as a person reads it, on GET /portfolio and in a thread's inspector. */
export const holdingWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Shares, side, or venue: "0.52 shares", "Polymarket, Yes, 12 shares". */
  detail: z.string(),
  /** A web-served path or a reviewed https logo; null shows the name's initial. */
  logoUrl: z.string().nullable(),
  usdValue: dollarsSchema,
  /** Since the person's midnight, at today's quantity; null when no price history was readable. */
  todayChangeUsd: dollarsSchema.nullable(),
});
export type HoldingWire = z.infer<typeof holdingWireSchema>;

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
  /** The network whose cash it is, when it's the USDC Auni spends there; null for anything else. */
  cash: z.enum(CASH_KEYS).nullable(),
});

export type DepositWire = z.infer<typeof depositWireSchema>;

/** Core's GET /portfolio: the live total, all non-cash holdings, and cash. */
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
  /** Money on its way between networks first ("On the way"), then every non-cash holding, largest first. */
  holdings: z.array(holdingWireSchema),
  /** Free cash across wallets, savings, and venue accounts. */
  cashUsd: dollarsSchema,
  /**
   * How many tokens in their wallets Auni neither recognises nor was told are
   * theirs: never counted, priced or named, and listed only when they open them
   * (see otherTokensWireSchema).
   */
  otherTokens: z.number().int().min(0),
  /** The latest few deposits recorded in the last hour, newest first. */
  deposits: z.array(depositWireSchema),
  /** The networks where a move can pay its network fee now (see feesPayable in money/fee-coin.ts). */
  feesPayable: z.array(z.enum(NETWORK_KEYS)),
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

/**
 * A take: a thread that holds positions now, by the fills Auni recorded in it, with its share of
 * each holding (never more than the wallet holds), what that is worth, and what it has made.
 */
const takeWireSchema = z.object({
  threadId: threadIdSchema,
  title: z.string(),
  /** What its holdings are worth now. */
  valueUsd: dollarsSchema,
  /**
   * Signed: what the holdings it has now made since it bought them, from what its own fills
   * paid for each (never the wallet's average), and for a perp what its venue says it has made;
   * null when nothing records any cost.
   */
  changeUsd: dollarsSchema.nullable(),
  /** What the holdings `changeUsd` counts cost (a perp's, the margin its entry put up); null with it. */
  costUsd: dollarsSchema.nullable(),
  /** Largest first. */
  holdings: z.array(
    holdingWireSchema.extend({
      /** What this holding alone has made since the take bought it, as `changeUsd` counts it. */
      changeUsd: dollarsSchema.nullable(),
      /** What it cost, as `costUsd` counts it; null with its change. */
      costUsd: dollarsSchema.nullable(),
      /** Savings, whose change is the interest they earned. */
      savings: z.boolean(),
    }),
  ),
});
export type TakeWire = z.infer<typeof takeWireSchema>;

/** Cash no take holds, in one place: the owner's own wallets, or an app that keeps some. */
const cashPlaceWireSchema = z.object({
  /** "wallet" for the owner's own wallets, which Withdraw sends from; else the app's id. */
  venue: z.string(),
  /** The app's name, as Withdraw names it. */
  name: z.string(),
  logoUrl: z.string().nullable(),
  /** It earns there (savings), rather than waiting to trade there. */
  savings: z.boolean(),
  usdValue: dollarsSchema,
});

/**
 * Core's GET /takes: every take, largest first, the holdings no take holds, and the cash no take
 * holds. Together with money on its way they add up to the portfolio's total.
 */
export const takesWireSchema = z.object({
  takes: z.array(takeWireSchema),
  /** Every holding, or the part of one, that no take holds and isn't cash, largest first. */
  loose: z.array(holdingWireSchema),
  /** The owner's own wallets first, always; then each app that keeps some, largest first. */
  cash: z.array(cashPlaceWireSchema),
});
export type TakesWire = z.infer<typeof takesWireSchema>;
