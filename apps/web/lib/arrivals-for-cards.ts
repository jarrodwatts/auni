import type { ArrivalCardWire } from "@auni/shared";

import { messageCards, type AuniUiMessage } from "./conversation";

/**
 * Money that came in while a plan's card waited on the owner, right after the answer holding it,
 * is that card's news: the card tells it in its own place, above the step it made possible
 * (ArrivedLine), and the chat doesn't tell it again under the card. Core names the plan still
 * waiting when it posts the news (`forPlan`, money/news.ts); money in after a plan settled names
 * none, so it keeps its own place and day, never drawn inside an old card. `told` is, by the
 * index of such an answer, the arrivals it tells; `folded` the indices of the messages they came
 * in, which the chat then leaves out. Only news core posted (no words, nothing but money in) is
 * taken; anything else between keeps its place.
 */
export function arrivalsForCards(turns: readonly AuniUiMessage[]): {
  readonly told: ReadonlyMap<number, readonly ArrivalCardWire[]>;
  readonly folded: ReadonlySet<number>;
} {
  const told = new Map<number, ArrivalCardWire[]>();
  const folded = new Set<number>();
  let card: { readonly index: number; readonly plans: ReadonlySet<string> } | null = null;
  turns.forEach((message, index) => {
    const arrivals = moneyIn(message);
    const plan = message.metadata?.forPlan;
    if (arrivals && card && plan && card.plans.has(plan)) {
      told.set(card.index, [...(told.get(card.index) ?? []), ...arrivals]);
      folded.add(index);
      return;
    }
    const plans = new Set(
      (message.role === "assistant" ? messageCards(message) : []).flatMap((one) =>
        one.kind === "action_plan" ? [one.proposalId] : [],
      ),
    );
    card = plans.size > 0 ? { index, plans } : null;
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
