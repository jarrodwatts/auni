import { z } from "zod";

import { cardBaseSchema } from "./card-base.ts";

/**
 * A card an app draws itself: which app, which of its views (`<view>.card.tsx` in its
 * folder), and the data that view is handed. The web parses `data` with the view's own schema
 * (`<view>.schema.ts` beside it) before drawing, and draws nothing it can't parse.
 */
export const appCardSchema = cardBaseSchema.extend({
  kind: z.literal("app"),
  app: z.string().min(1).max(64),
  view: z.string().min(1).max(64),
  data: z.unknown(),
});
export type AppCardWire = z.infer<typeof appCardSchema>;
