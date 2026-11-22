import type { CardWire } from "./card.ts";

/** The data parts an answer carries beside its text and tool calls, stored and streamed alike. */
export type MessageDataParts = {
  /** A tool's cards; the part's id is the tool call's, so they sit where the agent called it. */
  readonly cards: { readonly cards: readonly CardWire[] };
  /** How the answer was reached. The body never carries these words. */
  readonly reasoning: { readonly text: string };
};
