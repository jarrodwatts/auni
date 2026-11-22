import { z } from "zod";

import { cardIdSchema, timestampSchema } from "./shared.ts";

/** What every card carries, whatever it shows. */
export const cardBaseSchema = z.strictObject({
  id: cardIdSchema,
  title: z.string().trim().min(1).max(160),
  updatedAt: timestampSchema,
});
