import { z } from "zod";

import { dollarsSchema } from "./money.ts";
import { CASH_KEYS } from "./networks.ts";
import { listed } from "./words.ts";
import { actionRecordIdSchema, proposalIdSchema, threadIdSchema, timestampSchema } from "./shared.ts";

/**
 * Where a money action is. Cancelled: the owner declined it. Replaced: a newer card took its
 * place. Retracted: Auni took it back before any tap, for the reason RETRACTED names.
 */
export const actionStatusSchema = z.enum([
  "awaiting_permission",
  "running",
  "done",
  "failed",
  "cancelled",
  "replaced",
  "retracted",
]);
export type ActionStatus = z.infer<typeof actionStatusSchema>;

/**
 * How far a running move has got (core's money/life.ts is the whole of a move's life): allowed
 * and waiting its turn, being sent now, sent and landing later, stopped with something sent that
 * its receipts will settle, or held: stopped where nothing Auni can read says what it did, so
 * the owner is told once and can close it (see HELD).
 */
const movePhaseSchema = z.enum(["queued", "sending", "landing", "unsure", "needs_owner"]);
export type MovePhase = z.infer<typeof movePhaseSchema>;

/**
 * What a move's run wrote down as it went. Anything else in it is the move's own note to itself,
 * which only its own code reads back.
 */
export interface MoveRun {
  /** What is on its way where, for a move that lands later: "$29.00 on Arbitrum". */
  readonly lands?: string;
  /** The exact base units someone else's transaction pays the owner, where its hash can't be learned. */
  readonly landsUnits?: string;
  /** The transaction that delivered it. */
  readonly delivered?: string;
  /** What a sale brought back, to the cent, once it filled. */
  readonly returnedUsd?: string;
  /** What a buy spent, to the cent, once it filled: its card showed the most it could. */
  readonly spentUsd?: string;
  /**
   * What it filled, as its app says it, once done: "Bought 1.6919 Yes shares at 88.9¢ each,
   * $1.51 in all". Said to the agent and on the card's receipt.
   */
  readonly filled?: string;
  /** Why it is held, or was before it settled (see HELD). */
  readonly held?: HeldWhy;
  /**
   * How its outcome was learned, when its own run never recorded one: "read back" from its
   * receipts or its venue's own record after the run stopped, or "owner", who closed it held.
   */
  readonly settledBy?: "read back" | "owner";
  readonly [own: string]: string | undefined;
}

/**
 * Why a move is held, in the words its card, its channel message and the agent all read. A held
 * move stopped after it sent, or may have sent, and nothing Auni can read says what it did: the
 * chain confirmed a trade Auni has no reader for, a venue never answered, or a send never
 * confirmed. Auni reads again by itself, and the owner can have it read now or close the move.
 */
export const HELD = {
  unrecorded: "Its money moved, but Auni couldn't read what it got back.",
  unanswered: "Auni sent it and never heard back, so it can't tell whether it went through.",
  overdue: "It was sent over a day ago and still hasn't confirmed.",
} as const;
export type HeldWhy = keyof typeof HELD;

/** What is true of every held move, said once under why it is held. */
export const HELD_SAFE =
  "Auni won't send it again, and your portfolio shows what you hold either way.";

/** How long a card waits for the owner's tap before Auni takes it back as stale. */
export const CARD_WAITS_MS = 24 * 60 * 60_000;

/**
 * How a money card recorded now is drawn, which core stamps on its row and the web app names when
 * it allows one, as the format it drew. Raise it whenever cards start saying something they
 * didn't: a card recorded before is taken back, never allowed or tried again as it was shown, and
 * a tab still running the web app from before is told to reload (core's money/decide.ts).
 * 2 says every permission a move leaves.
 */
export const CARD_FORMAT = 2;

/**
 * Why Auni took back a card still waiting for the owner's tap, in the words its card, its
 * channel message and the agent all read: it waited a day (CARD_WAITS_MS), Auni no longer
 * stands behind it, or it was drawn before cards said all they say now (CARD_FORMAT).
 */
export const RETRACTED = {
  stale: "Taken back after a day without a tap. Ask again if you still want it.",
  agent: "Taken back by Auni: it no longer fits.",
  outOfDate: "Out of date: Auni's cards now say more about each move. Ask again for a fresh one.",
} as const;

/** How a held move the owner closed reads afterwards: when its money had moved, and when nothing showed it had. */
export const CLOSED = {
  moved: "You closed it. Its money moved, and Auni kept no record of what it got back.",
  unknown: "You closed it before Auni could tell whether it went through.",
} as const;

/**
 * What a move that filled really moved, as its run recorded it: what a sale brought back, or
 * what a buy spent; null until then, and for anything else.
 */
export function filledUsd(run: MoveRun): string | null {
  return run.returnedUsd ?? run.spentUsd ?? null;
}

/**
 * Why a move didn't go through, so its card offers the one next step that can
 * help: not enough money, a network blip, a busy venue, a price past what was
 * approved, a venue's rule, stopped because a move before it didn't go, an
 * order nobody filled that was closed with nothing moved, the coin its card
 * bought for its network fee not come (fees: the purchase went out once and is
 * never made again, so the move itself can run again), or something sent, or a
 * run that died partway and may have (never run again as it is). Unknown is
 * anything else.
 */
export const failureKindSchema = z.enum([
  "funds",
  "glitch",
  "busy",
  "price",
  "rule",
  "stopped",
  "unfilled",
  "fees",
  "sent",
  "unknown",
]);
export type FailureKind = z.infer<typeof failureKindSchema>;

/** One line of a move's card, in the order core wrote them: "Network: Base". */
const actionLineSchema = z.object({ label: z.string(), value: z.string() });
export type ActionLine = z.infer<typeof actionLineSchema>;

/**
 * The label of a move's line that says every lasting power it leaves anyone over the owner's
 * money, orders it places included: "Lets: 0x1a2b…9f8e spend your USDC".
 */
export const LETS_LINE = "Lets";

/** How a card says the lasting permissions a move leaves, wherever it's drawn. */
export const permissionsSaid = (lets: readonly string[]): string =>
  `From now on, it lets ${listed(lets)}.`;

/** One money action as core serves it, to the web and to the agent. */
export const actionWireSchema = z.object({
  id: actionRecordIdSchema,
  /** Null for a withdrawal started from Settings, outside every conversation. */
  threadId: threadIdSchema.nullable(),
  /** Legs of one proposal card share it. */
  proposalId: proposalIdSchema.nullable(),
  status: actionStatusSchema,
  /** How far it has got while it is running; null otherwise. */
  phase: movePhaseSchema.nullable(),
  /** The money tool that recorded it, which may be a removed app's. */
  tool: z.string(),
  venue: z.string().nullable(),
  /** Core's plain sentence for the move: "Buy about $50 of Nvidia on Solana". */
  summary: z.string(),
  /** Dollars the move spends, as code priced it. */
  amountUsd: dollarsSchema,
  /** What the card shows, labelled for people, in order. */
  lines: z.array(actionLineSchema),
  /** What code pinned when the card was made (approved bounds, addresses, mints); it never changes. */
  details: z.record(z.string(), z.string()),
  /** What its run wrote down as it went (see MoveRun): where it lands, what a sale brought back. */
  run: z.record(z.string(), z.string()),
  input: z.record(z.string(), z.unknown()),
  txs: z.array(
    z.object({
      chain: z.string(),
      hash: z.string(),
      /** An approval or other groundwork the move itself needed, not the move. */
      setup: z.boolean().optional(),
      /**
       * On the send that bought the coin for the move's network fee: the service's own id for
       * that order, to ask the service about it by, or "swap" for a swap on the chain itself.
       */
      buysFees: z.string().optional(),
    }),
  ),
  error: z.string().nullable(),
  /** Why it didn't go through, beside `error`; null while it hasn't failed. */
  failureKind: failureKindSchema.nullable(),
  /** Which run of it this is: one, and one more each time a failed step is tried again. */
  attempts: z.number().int().positive(),
  /**
   * Whether Try again can run it again as it is, as core judges by what it
   * recorded; false while it hasn't failed. A leg runs again with its card.
   */
  retryable: z.boolean().default(false),
  createdAt: timestampSchema,
  /** When money started moving. */
  startedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
});
export type ActionWire = z.infer<typeof actionWireSchema>;

/** `GET /actions/:id/quote`: a failed step priced again now, read only, against what was approved. */
export const actionQuoteWireSchema = z.object({
  /** Dollars it would move now. */
  amountUsd: dollarsSchema,
  /** One unit's price now, as its card says one ("$184.20"); null for a move priced without one. */
  price: z.string().nullable(),
  /** Whether running it again now stays inside what the person approved. */
  inside: z.boolean(),
});
export type ActionQuoteWire = z.infer<typeof actionQuoteWireSchema>;

/** `GET /proposals/:id` and its allow and decline: every leg, and what the waiting ones still need. */
export const proposalWireSchema = z.object({
  actions: z.array(actionWireSchema),
  /** The chain whose dollars the waiting legs spend, and how many more they need; null when nothing is short. */
  funding: z
    .object({
      chain: z.enum(CASH_KEYS),
      needUsd: dollarsSchema,
    })
    .nullable(),
});
export type ProposalWire = z.infer<typeof proposalWireSchema>;
