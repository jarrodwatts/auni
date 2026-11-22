import { z } from "zod";

import { actionCardSchema } from "./action-card.ts";
import { cardBaseSchema } from "./card-base.ts";
import {
  buysFirstSchema,
  pricedLaterSchema,
  specialistProposalMoveSchema,
  paysWithSchema,
} from "./specialist-proposal-card.ts";
import { proposalIdSchema } from "./shared.ts";

/** One move on a plan, as its own card would show it, with Auni's take on why it's there. */
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
    fromSpecialist: true,
    status: true,
  })
  .extend({
    /**
     * The one short line under its name on the plan, in core's words whatever its recipe: where
     * it goes or lands ("To Arbitrum, after a $1 fee"). Null for none.
     */
    line: z.string().max(300).nullable(),
    /** Auni's take in its own voice, shown when the move is opened, when it gave one. */
    note: z.string().trim().min(1).max(280).optional(),
  });
export type ActionPlanLeg = z.infer<typeof actionPlanLegSchema>;

/**
 * Several money moves outside a specialist, offered at once: "close these
 * three positions", or "buy $5 of NVIDIA" with the moves that get the cash
 * there. One Allow covers every leg, and each then runs on its own.
 */
export const actionPlanCardSchema = cardBaseSchema.extend({
  kind: z.literal("action_plan"),
  proposalId: proposalIdSchema,
  /**
   * The button that allows the whole card, in core's words for what all of it does: "Long BTC",
   * "Buy both for {amount}", "Take out, move and sell". It may hold `AMOUNT`, which stands for
   * the money the card shows at its head.
   */
  action: z.string().max(120),
  /** What the person asked for; every move when the card only moves cash. */
  legs: z.array(actionPlanLegSchema).min(1).max(12),
  /** What gets the money ready first, as a specialist's card runs it. */
  moves: z.array(specialistProposalMoveSchema).max(11),
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
