import { z } from "zod";

import { arrivalCardSchema } from "./arrival-card.ts";
import { cardBaseSchema } from "./card-base.ts";
import { dollarsSchema } from "./money.ts";
import { NETWORK_KEYS } from "./networks.ts";

/**
 * Where to send money in, which wait_for_deposit puts in the chat: on the
 * network they said they'd send on, or on every one. It carries no address:
 * the web shows the person's own, read from their account, so no card can
 * put another in front of them. Once a deposit wakes the thread, core lands
 * it in place with what came in.
 */
export const depositCardSchema = cardBaseSchema.extend({
  kind: z.literal("deposit"),
  /** The network they said they'd send on; null for any. */
  network: z.enum(NETWORK_KEYS).nullable(),
  /**
   * What they said they'd send, as they named it ("STANDARD"), which the title
   * names, and the contract or mint the agent resolved it to on `network`, if it
   * did: only a token at that address landing there is taken as theirs, since
   * any token can call itself by a name.
   */
  tokens: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(24),
        address: z.string().trim().min(32).max(44).nullable(),
      }),
    )
    .max(4),
  /** What came in, once it has: one transaction, as an arrival card says it; null while waiting. */
  landed: arrivalCardSchema
    .pick({ network: true, moved: true })
    .extend({ usdValue: dollarsSchema })
    .nullable(),
});
export type DepositCardWire = z.infer<typeof depositCardSchema>;

/**
 * How long a deposit card waits on its thread's next deposit: a day. Money landing later is
 * unrelated to the card as often as not, so it is news in their main chat, as any arrival is;
 * the card stops watching, and the sweep stops hurrying for it.
 */
export const DEPOSIT_WAIT_MS = 24 * 60 * 60_000;
