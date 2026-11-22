import type { ArrivalCardWire, CardWire } from "@auni/shared";

import { messageCards, type AuniUiMessage } from "./conversation";

/** Cards that put money in, which may wait on money arriving before they can. */
const MONEY_IN = new Set<CardWire["kind"]>(["specialist_proposal", "action_plan"]);

/**
 * Money that came in right after an answer whose card puts money in is that card's news: the card
 * tells it in its own place, above the step it made possible (ArrivedLine), and the chat doesn't
 * tell it again under the card. `told` is, by the index of such an answer, the arrivals it tells;
 * `folded` the indices of the messages they came in, which the chat then leaves out. Only news
 * core posted (no words, nothing but money in) is taken; anything else between keeps its place.
 */
export function arrivalsForCards(turns: readonly AuniUiMessage[]): {
  readonly told: ReadonlyMap<number, readonly ArrivalCardWire[]>;
  readonly folded: ReadonlySet<number>;
} {
  const told = new Map<number, ArrivalCardWire[]>();
  const folded = new Set<number>();
  let card: number | null = null;
  turns.forEach((message, index) => {
    const arrivals = moneyIn(message);
    if (arrivals && card !== null) {
      told.set(card, [...(told.get(card) ?? []), ...arrivals]);
      folded.add(index);
      return;
    }
    const cards = message.role === "assistant" ? messageCards(message) : [];
    card = cards.some(({ kind }) => MONEY_IN.has(kind)) ? index : null;
  });
  return { told, folded };
}

/** The arrivals a message is, when it is only core's news of money coming in. */
function moneyIn(message: AuniUiMessage): readonly ArrivalCardWire[] | null {
  if (!message.metadata?.posted) return null;
  if (message.parts.some((part) => part.type === "text")) return null;
  const cards = messageCards(message);
  const arrivals = cards.filter(
    (card): card is ArrivalCardWire => card.kind === "arrival" && card.direction === "in",
  );
  return arrivals.length > 0 && arrivals.length === cards.length ? arrivals : null;
}
