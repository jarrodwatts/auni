import { z } from "zod";

import { cardBaseSchema } from "./card-base.ts";

/**
 * Money that moved without Auni, which core posts into their chat once per
 * transaction: money in from outside (a deposit, or savings paid back), or
 * money that left their wallet that Auni didn't send; or a token of
 * theirs Auni came to recognise. The title says it in dollars ("$250
 * arrived", "Your XYZ is now worth $40").
 */
export const arrivalCardSchema = cardBaseSchema.extend({
  kind: z.literal("arrival"),
  direction: z.enum(["in", "out"]),
  /** As people read it: "Base". */
  network: z.string().trim().min(1).max(40),
  /** What moved, each worth a cent or more. */
  moved: z
    .array(
      z.strictObject({
        /** "0.081" */
        amount: z.string().min(1).max(80),
        /** As core names it by its bucket: "ETH", "USDC", or a short address. */
        symbol: z.string().min(1).max(40),
        /** Where money out went, as "0x1a2b3c…9f8e"; null for money in, or when the chain doesn't say. */
        to: z.string().max(40).nullable(),
        /** Its own network when a deposit receipt spans several networks. */
        network: z.string().trim().min(1).max(40).optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type ArrivalCardWire = z.infer<typeof arrivalCardSchema>;
