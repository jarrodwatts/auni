import { z } from "zod";

import { cardBaseSchema } from "../card-base.ts";
import { automationRuleIdSchema } from "../shared.ts";
import { automationStatusSchema } from "./rule.ts";

/** The in-chat card the watch tool returns; the live watch is read by id. */
export const automationCardSchema = cardBaseSchema.extend({
  kind: z.literal("automation"),
  automationId: automationRuleIdSchema,
  summary: z.string().trim().min(1).max(500),
  status: automationStatusSchema,
});
