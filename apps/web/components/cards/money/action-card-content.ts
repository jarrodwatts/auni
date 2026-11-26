import {
  fillFace,
  permissionsSaid,
  type ActionCardWire,
  type ActionPlanCardWire,
  type CardFace,
  type FilledFace,
} from "@auni/shared";

import { dollarsToBaseUnits } from "@/lib/data/usdc";

/** What a card draws without a picture: the initials of what it's about ("PRL"), or its venue's mark. */
type PlainMark =
  | { readonly kind: "initials"; readonly name: string }
  | { readonly kind: "integration"; readonly integration: ActionCardWire["venue"] };

export type MoneyCardMark =
  | PlainMark
  | {
      readonly kind: "image";
      readonly src: string;
      readonly fallback: PlainMark;
      /** A mark drawn on transparency, set in from the circle's edge. */
      readonly inset?: boolean;
    };

/** Everything a money card shows: its mark, and its face with the card's amount filled in. */
type ActionCardContent = Omit<FilledFace, "logo"> & { readonly mark: MoneyCardMark };

type Card = Pick<ActionCardWire, "card" | "venue" | "logoUrl" | "logoName" | "amount">;

/**
 * What a card wears: the mark its face brings (the app a transaction was built for, as its logo
 * or else its initial), else the picture core sent for what the move is about, else that thing's
 * initials, else its venue's mark: cash going to or from a venue. One rule for a card and for a
 * plan's leg, so one service never wears two letters.
 */
export function cardMark({
  card,
  logoUrl,
  logoName,
  venue,
}: Pick<Card, "logoUrl" | "logoName" | "venue"> & {
  readonly card?: Pick<CardFace, "logo">;
}): MoneyCardMark {
  if (card?.logo) return faceMark(card.logo);
  const plain: PlainMark = logoName
    ? { kind: "initials", name: logoName }
    : { kind: "integration", integration: venue };
  return logoUrl ? { kind: "image", src: logoUrl, fallback: plain } : plain;
}

/**
 * What a single action's card shows: the face core sent, with the card's amount filled in, and
 * its mark. Every word is the move's own, written beside the code that prices it; the web only
 * draws it.
 */
export function actionCardContent(card: Card): ActionCardContent {
  const { logo, ...face } = fillFace(card.card, card.amount);
  return { mark: cardMark({ ...card, card: { logo } }), ...face };
}

/** The app's own logo when core has one, else that app's initial. */
function faceMark({ src, inset, name }: NonNullable<CardFace["logo"]>): MoneyCardMark {
  const initials = { kind: "initials", name } as const;
  return src ? { kind: "image", src, inset, fallback: initials } : initials;
}

/**
 * A card or leg as it stands once it ran: a move that filled shows what it
 * really moved (see filledUsd), which the agent's report says too, rather
 * than what its preview priced, or the most it could cost, when the card was drawn.
 */
export function withFilled<T extends { readonly amount?: ActionCardWire["amount"] }>(
  card: T,
  filled: string | null | undefined,
): T {
  if (!filled || !card.amount) return card;
  return {
    ...card,
    amount: { ...card.amount, baseUnits: dollarsToBaseUnits(filled).toString() },
  };
}

/**
 * How much of a card's grid of figures one takes, so a value is always read whole, never cut: a
 * column; the whole row at a phone's two columns but one of a wider card's three; or the whole
 * row anywhere. Measured in characters, as the grid can't measure words: a value of up to 16
 * fits a phone's column, of up to 32 a wider card's, so a medium one never leaves a gap beside
 * it. An address takes a row of its own.
 */
export function figureWidth(
  { value, note }: Pick<CardFace["figures"][number], "value" | "note">,
  address: boolean,
): "column" | "wide" | "row" {
  const length = value.length + (note ? note.length + 2 : 0);
  if (address || length > 32) return "row";
  return length > 16 ? "wide" : "column";
}

/**
 * What a plan's moves leave behind, since one tap agrees to it all, each entry whole and under the
 * name of the move that leaves it, so two moves that leave alike are never read as one: what the
 * moves that bring its cash first leave (its Lets line, as they run first), then each leg's, as
 * its card says it (core's withLeaves): money it sends for good, every permission, and every
 * order left resting, such as a stop on a position already held. Permissions come first, orders
 * after.
 */
export function planPermissions(plan: {
  readonly legs: readonly Pick<ActionPlanCardWire["legs"][number], "summary" | "card">[];
  readonly moves: readonly Pick<ActionPlanCardWire["moves"][number], "name" | "lets">[];
}): { readonly says: string; readonly order: boolean }[] {
  const named = [
    ...plan.moves.flatMap(({ name, lets }) =>
      lets ? [{ name, says: permissionsSaid([lets]), order: false }] : [],
    ),
    ...plan.legs.flatMap(({ summary, card }) => [
      ...(card.warning ? [{ name: summary, says: card.warning, order: false }] : []),
      ...(card.leaves ?? []).map(({ says, order }) => ({
        name: summary,
        says,
        order: order === true,
      })),
    ]),
  ];
  const said = named.map(({ name, says, order }) => ({ says: `${name}: ${says}`, order }));
  return [...said.filter(({ order }) => !order), ...said.filter(({ order }) => order)];
}
