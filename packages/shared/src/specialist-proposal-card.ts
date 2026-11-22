import { z } from "zod";

import { actionStatusSchema } from "./action.ts";
import { cardBaseSchema } from "./card-base.ts";
import { APP_MARKS } from "./apps.generated.ts";
import { moneyWireSchema } from "./money.ts";
import { actionRecordIdSchema, specialistIdSchema, proposalIdSchema } from "./shared.ts";

/** Same-origin artwork or an https logo; a leg without one shows its venue mark. */
export const cardLogoUrlSchema = z
  .string()
  .max(2_000)
  .refine(
    (value) => (value.startsWith("/") && !value.startsWith("//")) || value.startsWith("https://"),
    {
      message: "must be a same-origin path or an https URL",
    },
  );

/**
 * The mark a money card carries when it has no logo of its own: an app's
 * (see AppAbout.mark), or one of Auni's own for a stock trade, a swap, and
 * anything else.
 */
export const cardVenueSchema = z.enum(["auni", "stocks", "swap", ...APP_MARKS]);

/**
 * Which way a money card's amount goes: into what it buys, back to cash from
 * what it sells or closes, or across, cash carried between the person's own
 * places (a bridge, savings back to the wallet).
 */
export const moneyFlowSchema = z.enum(["in", "back", "move"]);
export type MoneyFlow = z.infer<typeof moneyFlowSchema>;

const specialistProposalLegSchema = z.strictObject({
  /** The action this leg runs; one tap on the card allows every leg. */
  actionReference: actionRecordIdSchema,
  name: z.string().trim().min(1).max(120),
  /** Auni's one-line reason this leg belongs to the specialist. */
  why: z.string().trim().min(1).max(200),
  /** Auni's take in its own voice: why it's here and what would change its mind. */
  note: z.string().trim().min(1).max(280).optional(),
  venue: cardVenueSchema,
  logoUrl: cardLogoUrlSchema.nullable(),
  /** What goes in, or comes back with `flow`; zero for a pick that moves no money. */
  amount: moneyWireSchema,
  flow: moneyFlowSchema,
  /**
   * What it costs to fill, said only when that is more than a normal
   * trade's, as one into a thin market is: "$0.77". It never runs without a tap.
   */
  cost: z.string().trim().min(1).max(40).optional(),
  /** The other specialist whose holding this leg sells or closes, said rather than stopped. */
  fromSpecialist: z.string().trim().min(1).max(160).optional(),
  /**
   * A perp's bet, which its row says beside its name rather than in it: the
   * one it opens, or with `closes` the one it lets go of. Absent on any other pick.
   */
  perp: z
    .strictObject({
      side: z.enum(["long", "short"]),
      leverage: z.int().min(1),
      /** The position its margin holds, or the share of one a close lets go of: "$60". */
      size: z.string(),
      /** How far the price can go against it before its margin is gone: 0.32 is 32%. */
      liquidationMove: z.number().optional(),
      /** On a close: whether it lets go of the whole position, and what that locks in, made or lost. */
      closes: z.strictObject({ all: z.boolean(), pnlUsd: z.number() }).optional(),
    })
    .optional(),
  /**
   * What its row says before its name while it runs, once done, and if it did not go through,
   * when buying or selling is the wrong word: its move's own (see CardFace.pick), as a bet's are.
   */
  verbs: z
    .strictObject({ now: z.string().max(40), done: z.string().max(40), failed: z.string().max(40) })
    .optional(),
  /** Where the leg started; the card reads it live. */
  status: actionStatusSchema,
});
export type SpecialistProposalLeg = z.infer<typeof specialistProposalLegSchema>;

/** Money moved to where the picks need it, never a pick itself: "Move $3.73 to Solana". */
export const specialistProposalMoveSchema = z.strictObject({
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
export type SpecialistProposalMove = z.infer<typeof specialistProposalMoveSchema>;

/**
 * Each holding a card converts to USDC to pay for its picks, said before the
 * tap, since nothing converts until then: "0.081 ETH on Base → about $252
 * USDC, fee about $1.27, $250 of it moved to Monad". Absent when it pays with
 * cash alone.
 */
export const paysWithSchema = z.array(z.string().trim().min(1).max(160)).max(4).optional();

/**
 * The one quiet line of what a card's moves also buy for their network fees, which is no cost
 * (core's money/fee-coin-said.ts); absent when no move on the card buys any.
 */
export const buysFirstSchema = z.string().trim().min(1).max(600).optional();

/**
 * What a card of several moves says, before the tap, of the trades on it that wait for its money
 * moves to land: they are priced again when their turn comes, and go only inside what the card
 * shows. Core writes it (`pricedLater`); absent when no priced trade waits.
 */
export const pricedLaterSchema = z.string().trim().min(1).max(600).optional();

/**
 * A whole specialist offered at once: every pick, its reason, and the money
 * behind it. One Allow covers every leg: the money moves run first, then the
 * picks, each on its own.
 */
export const specialistProposalCardSchema = cardBaseSchema.extend({
  kind: z.literal("specialist_proposal"),
  proposalId: proposalIdSchema,
  specialistId: specialistIdSchema,
  /** The person's own words for what they believe. */
  specialistName: z.string().trim().min(1).max(160),
  /**
   * True when the specialist had bought something before this card, so its button adds to it
   * ("Add $2") rather than starts it ("Start with $2").
   */
  adds: z.boolean().optional(),
  /** The picks. */
  legs: z.array(specialistProposalLegSchema).min(1).max(12),
  /** What gets the money ready first. */
  moves: z.array(specialistProposalMoveSchema).max(11),
  paysWith: paysWithSchema,
  buysFirst: buysFirstSchema,
  pricedLater: pricedLaterSchema,
});
export type SpecialistProposalCardWire = z.infer<typeof specialistProposalCardSchema>;
