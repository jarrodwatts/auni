import type { SpecialistProposalLeg, MoneyFlow } from "@auni/shared";

import { formatExactUsd, formatUsd } from "@/lib/money";

/** A pick's money as its card carries it: how much, and which way. */
type Money = Pick<SpecialistProposalLeg, "amount" | "flow">;

/** What some picks move one way, in base units: what goes in, or what comes back. */
export function sum(legs: readonly Money[], flow: MoneyFlow): bigint {
  return legs.reduce(
    (total, leg) => (leg.flow === flow ? total + BigInt(leg.amount.baseUnits) : total),
    0n,
  );
}

/**
 * Which money heads a card: what its picks put in, which is what the tap asks
 * of the person, or what they bring back when nothing goes in.
 */
export function headline(legs: readonly Money[]): "in" | "back" {
  return sum(legs, "in") === 0n && sum(legs, "back") > 0n ? "back" : "in";
}

/**
 * A pick's money: what goes in plainly, what comes back with a plus, as money
 * arriving reads anywhere; nothing for a pick that moves none.
 */
export function amountLabel(units: bigint, decimals: number, flow: MoneyFlow): string | null {
  if (units === 0n) return null;
  const amount = formatExactUsd(units.toString(), decimals);
  return flow === "back" ? `+${amount}` : amount;
}

/** The picks behind "N more": their money, when it all goes one way. */
export function restLabel(legs: readonly Money[]): string | null {
  const decimals = legs[0]?.amount.currency.decimals ?? 6;
  const going = sum(legs, "in");
  const back = sum(legs, "back");
  if (going > 0n && back > 0n) return null;
  return going > 0n ? amountLabel(going, decimals, "in") : amountLabel(back, decimals, "back");
}

type Perp = NonNullable<SpecialistProposalLeg["perp"]>;

/** A perp's bet beside its name, always with its direction: "3x long". */
export function perpTag(perp: Perp): string {
  return `${perp.leverage}x ${perp.side}`;
}

/**
 * What a perp's margin holds and what would wipe it out: "$60 position · gone
 * if it falls 30%". The move is rounded down, so the price never gets as far
 * as the row says before the margin is gone. A close says which bet it lets
 * go of: "Your 3x long", or "$21 of your 3x long".
 */
export function perpLine(perp: Perp): string {
  if (perp.closes) return `${perp.closes.all ? "Your" : `${perp.size} of your`} ${perpTag(perp)}`;
  const percent = (perp.liquidationMove ?? 0) * 100;
  const gone = percent >= 10 ? Math.floor(percent / 5) * 5 : Math.floor(percent);
  // A 1x long can only go as far as the price itself, which says nothing.
  if (gone < 1 || gone >= 100) return `${perp.size} position`;
  return `${perp.size} position, gone if it ${perp.side === "long" ? "falls" : "rises"} ${gone}%`;
}

/** What closing a perp locks in, said as it happened to the money: "down $4.63". Nothing for under a cent. */
export function closeResult(perp: Perp): { readonly text: string; readonly down: boolean } | null {
  const pnl = perp.closes?.pnlUsd;
  if (pnl === undefined || Math.abs(pnl) < 0.005) return null;
  return {
    text: `${pnl < 0 ? "down" : "up"} ${formatUsd(Math.abs(pnl).toFixed(2))}`,
    down: pnl < 0,
  };
}

/**
 * What a pick does, said on a card that both puts money in and brings some
 * back, where its amount's sign alone is too quiet: a perp opens or closes,
 * anything else is bought or sold.
 */
export function pickVerb(leg: Pick<SpecialistProposalLeg, "flow" | "perp">): string {
  if (leg.flow === "back") return leg.perp ? "Close" : "Sell";
  return leg.perp ? "Open" : "Buy";
}
