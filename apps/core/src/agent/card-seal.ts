import { createHmac, timingSafeEqual } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { env } from "../env.ts";

// A card reaches the web through the brain's output, and the agent does whatever a prompt
// injection tells it to. Only a card core's own tool built carries a seal that checks out, so the
// agent can't show one move on a card while Allow runs another.

function seal(card: unknown): Buffer {
  // The turn token signs base64url text, which never holds a NUL, so the two can't collide.
  return createHmac("sha256", env.TURN_TOKEN_SECRET)
    .update(`card\0${JSON.stringify(card)}`)
    .digest();
}

/** A tool result whose card leaves for the brain with its seal beside it. */
export function sealCard(result: CallToolResult): CallToolResult {
  const card = result.structuredContent?.card;
  if (!card) return result;
  return {
    ...result,
    structuredContent: {
      ...result.structuredContent,
      cardSeal: seal(card).toString("base64url"),
    },
  };
}

/** Whether core sealed this card, exactly as it came back. */
export function isSealed(card: unknown, cardSeal: unknown): boolean {
  if (typeof cardSeal !== "string") return false;
  const given = Buffer.from(cardSeal, "base64url");
  const expected = seal(card);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
