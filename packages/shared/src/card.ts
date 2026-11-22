import { z } from "zod";
import { actionCardSchema } from "./action-card.ts";
import { appCardSchema } from "./app-card.ts";
import { actionPlanCardSchema } from "./action-plan-card.ts";
import { arrivalCardSchema } from "./arrival-card.ts";
import { askCardSchema } from "./ask-card.ts";
import { automationCardSchema } from "./automation/card-shape.ts";
import { specialistProposalCardSchema } from "./specialist-proposal-card.ts";
import { specialistUpdateCardSchema } from "./specialist-update-card.ts";
import { depositCardSchema } from "./deposit-card.ts";
import { feedbackCardSchema } from "./feedback.ts";
import { venueEventCardSchema } from "./venue-event-card.ts";

export const cardWireSchema = z.discriminatedUnion("kind", [
  actionCardSchema,
  actionPlanCardSchema,
  specialistProposalCardSchema,
  specialistUpdateCardSchema,
  askCardSchema,
  automationCardSchema,
  appCardSchema,
  arrivalCardSchema,
  depositCardSchema,
  feedbackCardSchema,
  venueEventCardSchema,
]);
export type CardWire = z.infer<typeof cardWireSchema>;
