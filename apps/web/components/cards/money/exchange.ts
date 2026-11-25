import type { FilledFace } from "@auni/shared";

type Figure = FilledFace["figures"][number];

/** A card's figures as drawn: what changes hands, said once, and the rest. */
export interface Exchange {
  /**
   * What the owner gives and what they get for it, drawn as one leading to the other: only when
   * neither side is the card's own amount, which its head already says (60 MON for 60 sMON).
   */
  readonly scene: { readonly pays: Figure; readonly gets: Figure } | null;
  /**
   * When one side is the card's amount, the other side as one line under its title, at its price
   * when the face names one: "About 1.4297 shares at $174.69", "Up to 310 shares at 62¢".
   */
  readonly result: string | null;
  /** Every other figure the tap agrees to, in the face's order. */
  readonly facts: readonly Figure[];
}

/**
 * Splits a face's figures into the exchange it describes and its other facts, so the card's
 * amount is said once, in its head. A face that names both sides (see CardFace's `role`) draws
 * them as a scene, unless one side is that amount: then the other side is said under the title,
 * when its label says how sure it is ("You get, about"), or else is one more fact. A face that
 * names no exchange keeps every figure as a fact but one that only repeats the amount.
 */
export function exchangeOf(figures: readonly Figure[], amount: string): Exchange {
  const pays = figures.find((figure) => figure.role === "pays");
  const gets = figures.find((figure) => figure.role === "gets");
  if (!pays || !gets) {
    return {
      scene: null,
      result: null,
      facts: figures.filter((figure) => figure.value !== amount),
    };
  }
  const rest = figures.filter((figure) => figure !== pays && figure !== gets);
  const other = pays.value === amount ? gets : gets.value === amount ? pays : null;
  if (!other) return { scene: { pays, gets }, result: null, facts: rest };
  // "You get, about" says how sure it is: "about". A label with none ("Position") is a plain fact.
  const sure = other.label.split(",")[1]?.trim();
  if (!sure) return { scene: null, result: null, facts: [other, ...rest] };
  const price = rest.find((figure) => figure.label === "Price");
  const said = `${sure} ${other.value}${price ? ` at ${price.value}` : ""}`;
  return {
    scene: null,
    result: said.charAt(0).toUpperCase() + said.slice(1),
    facts: rest.filter((figure) => figure !== price),
  };
}
