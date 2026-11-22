import { z } from "zod";

import { actionCardSchema } from "./action-card.ts";
import { actionStatusSchema } from "./action.ts";
import { cardBaseSchema } from "./card-base.ts";
import { actionRecordIdSchema, proposalIdSchema } from "./shared.ts";

/** Money moved to where the plan's buys need it, never a pick itself: "Move $3.73 to Solana". */
const planMoveSchema = z.strictObject({
  actionReference: actionRecordIdSchema,
  name: z.string().trim().min(1).max(120),
  /**
   * Where its money sits until it goes through: "your Arbitrum wallet". Absent
   * for a token bridged in or sold home, which spends no wallet's cash.
   */
  from: z.string().trim().min(1).max(60).optional(),
  /**
   * Where its cash lands: a network, or a venue's account by its app id. Absent for a move
   * that readies no cash.
   */
  lands: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/u)
    .max(64)
    .optional(),
  status: actionStatusSchema,
});
export type PlanMove = z.infer<typeof planMoveSchema>;

/**
 * Each holding a card converts to USDC to pay for its buys, said before the
 * tap, since nothing converts until then: "0.081 ETH on Base → about $252
 * USDC, fee about $1.27, $250 of it moved to Monad". Absent when it pays with
 * cash alone.
 */
const paysWithSchema = z.array(z.string().trim().min(1).max(160)).max(4).optional();

/**
 * The one quiet line of what a card's moves also buy for their network fees, which is no cost
 * (core's money/fee-coin-said.ts); absent when no move on the card buys any.
 */
const buysFirstSchema = z.string().trim().min(1).max(600).optional();

/**
 * What a card of several moves says, before the tap, of the trades on it that wait for its money
 * moves to land: they are priced again when their turn comes, and go only inside what the card
 * shows. Core writes it (`pricedLater`); absent when no priced trade waits.
 */
const pricedLaterSchema = z.string().trim().min(1).max(600).optional();

/** One move or pick on a plan, as its own card would show it, with Auni's take on why it's there. */
const actionPlanLegSchema = actionCardSchema
  .pick({
    actionReference: true,
    tool: true,
    venue: true,
    logoUrl: true,
    logoName: true,
    summary: true,
    lines: true,
    details: true,
    card: true,
    amount: true,
    flow: true,
    status: true,
  })
  .extend({
    /** Optional short asset name when proposed as a pick ("Eli Lilly"). */
    name: z.string().trim().min(1).max(120).optional(),
    /** Optional one-line reason this pick belongs ("Makes the leading weight-loss drugs"). */
    why: z.string().trim().min(1).max(200).optional(),
    /**
     * The one short line under its name on the plan, in core's words whatever its recipe: where
     * it goes or lands ("To Arbitrum, after a $1 fee"). Null for none.
     */
    line: z.string().max(300).nullable(),
    /** Auni's take in its own voice, shown when the move is opened, when it gave one. */
    note: z.string().trim().min(1).max(280).optional(),
    /** Higher-than-normal fill cost, said only when past normal spread ("$0.77"). */
    cost: z.string().trim().min(1).max(40).optional(),
    /** Perp metadata shown beside the pick name when applicable. */
    perp: z
      .strictObject({
        side: z.enum(["long", "short"]),
        leverage: z.int().min(1),
        size: z.string(),
        liquidationMove: z.number().optional(),
        closes: z.strictObject({ all: z.boolean(), pnlUsd: z.number() }).optional(),
      })
      .optional(),
    verbs: z
      .strictObject({ now: z.string().max(40), done: z.string().max(40), failed: z.string().max(40) })
      .optional(),
  });
export type ActionPlanLeg = z.infer<typeof actionPlanLegSchema>;

/**
 * Several money moves or a basket of picks, offered at once: "Peptides picks",
 * "Close these three positions", or "Buy $5 of NVIDIA" with the moves that get
 * the cash there. One Allow covers every leg, and each then runs on its own.
 */
export const actionPlanCardSchema = cardBaseSchema.extend({
  kind: z.literal("action_plan"),
  proposalId: proposalIdSchema,
  /**
   * The button that allows the whole card, in core's words for what all of it does: "Long BTC",
   * "Buy all for {amount}", "Take out, move and sell". It may hold `AMOUNT`, which stands for
   * the money the card shows at its head.
   */
  action: z.string().max(120),
  /** What the person asked for; every move when the card only moves cash. */
  legs: z.array(actionPlanLegSchema).min(1).max(12),
  /** What gets the money ready first. */
  moves: z.array(planMoveSchema).max(11),
  paysWith: paysWithSchema,
  buysFirst: buysFirstSchema,
  pricedLater: pricedLaterSchema,
  /**
   * What its moves cost in all, each kind summed, said before the tap: "$1.00 Hyperliquid fee",
   * or "$1.25 ($1.00 Hyperliquid fee, $0.25 network fee)". Absent when they cost nothing.
   */
  costs: z.string().max(300).optional(),
});
export type ActionPlanCardWire = z.infer<typeof actionPlanCardSchema>;
