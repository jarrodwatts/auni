import { z } from "zod";

import { actionStatusSchema } from "./action.ts";
import { cardBaseSchema } from "./card-base.ts";
import { cardFaceSchema } from "./card-face.ts";
import { cardLogoUrlSchema, cardVenueSchema, moneyFlowSchema } from "./specialist-proposal-card.ts";
import { moneyWireSchema } from "./money.ts";
import { actionRecordIdSchema } from "./shared.ts";
import { ACTION_TOOL_NAMES } from "./tools.ts";

/**
 * One money action the agent took on its own, drawn where the agent took it. The
 * card reads the action live; these fields are what it looked like then.
 */
export const actionCardSchema = cardBaseSchema.extend({
  kind: z.literal("action"),
  actionReference: actionRecordIdSchema,
  tool: z.enum(ACTION_TOOL_NAMES),
  venue: cardVenueSchema,
  logoUrl: cardLogoUrlSchema.nullable(),
  /** What the logo shows, by name ("PRL", "USDC"); a card with no logo draws its initials. */
  logoName: z.string().trim().min(1).max(40).nullable(),
  /** Core's plain sentence for the move: "Buy about $50 of Nvidia on Solana". */
  summary: z.string().trim().min(1).max(500),
  /** What the move gives, gets, costs and lets, in that order (see effect.ts in core). */
  lines: z.array(z.object({ label: z.string().max(60), value: z.string().max(500) })),
  /** What code pinned at the preview. */
  details: z.record(z.string().max(60), z.string().max(500)),
  /**
   * What the card says: the face its move wrote, or the plain one core makes of any move. Drawn
   * with `amount` filled in (see fillFace), the same in the web app and on every channel.
   */
  card: cardFaceSchema,
  /** What goes in, or comes back with `flow`; zero for a move that moves no money. */
  amount: moneyWireSchema,
  flow: moneyFlowSchema,
  /** The specialist whose holding this move sells or closes, when it isn't the thread's own. */
  fromSpecialist: z.string().trim().min(1).max(160).optional(),
  /** Allowing it takes proof the owner is at the computer, as core's approval ladder says. */
  takesProof: z.boolean().optional(),
  /** Why it does, in one sentence the card says to the owner. */
  proofWhy: z.string().max(200).optional(),
  status: actionStatusSchema,
  error: z.string().max(500).nullable(),
});
export type ActionCardWire = z.infer<typeof actionCardSchema>;
