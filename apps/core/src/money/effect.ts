import type { ActionLine } from "@auni/shared";

import { feeLabel, shortAddress, usdLabel } from "./format.ts";

// What a move does to the owner's money, whoever built its bytes: what they
// give, what they get and where Auni sees it, and any lasting power anyone
// gains over their money. Code computes it, never the agent. A recipe built from
// fixed contracts Auni reviewed declares it; bytes someone else built (a
// route, a bridge's calldata, the agent's own transaction) are simulated from the
// owner's wallet before they are signed and held to it. How a move is approved,
// and what its card says, both follow from it alone.

/** Something that moves, as the card says it: "0.01 WETH", "$50.00 of USDC on Base". */
export interface Amount {
  readonly text: string;
  /** What it's worth in dollars, said beside it; absent when the text is dollars or it can't be priced. */
  readonly usd?: number;
}

/**
 * What comes back. Gets count only where Auni can see them: in the owner's
 * wallet once the move lands, as a simulation or Auni's own recipe shows, or
 * where Auni's own recipe sends it and reads it back (`lands`), which keeps
 * the move running until it does and tells the owner if it doesn't (see
 * Recipe.landed). A contract's event or anything the agent wrote never counts.
 */
interface Get extends Amount {
  /** Where Auni's own recipe will read it back: "in the account in ~1 min". */
  readonly lands?: string;
}

/** A lasting power over the owner's money, as what it lets someone do: "0x1a2b…9f8e spend your USDC". */
export interface Grant {
  readonly lets: string;
  /**
   * What it can reach: the owner's main wallet, or only what they have already
   * put in a venue's wallet or account of their own.
   */
  readonly reach: "wallet" | "venue";
}

/** Part of what a move costs, in dollars. */
export interface Cost {
  /** What it is, said after its dollars, to the owner: "network fee", "price move". */
  readonly label: string;
  readonly usd: number;
}

export interface Effect {
  readonly gives: readonly Amount[];
  readonly gets: readonly Get[];
  readonly grants: readonly Grant[];
  readonly costs?: readonly Cost[];
  /** Where money leaving the owner goes (see leavesYou); absent or empty when Auni can't name it. */
  readonly to?: readonly string[];
  /**
   * Why a tap can't vouch for all it does, so it takes the owner's proof: a call Auni
   * can't read, an account an app keeps that it changes, calls that land one
   * at a time, a fee its builder set past what a tap allows.
   */
  readonly blind?: string;
}

/** Money that leaves the owner: something goes, and nothing comes back anywhere Auni can see. */
function leavesYou(effect: Effect): boolean {
  return effect.gives.length > 0 && effect.gets.length === 0;
}

/**
 * Why an effect takes proof the owner is there, wherever its money goes:
 * each lasting power over the main wallet, and anything a tap can't see.
 */
export function stepUpOnly(effect: Effect): string[] {
  return [
    ...effect.grants.flatMap(({ lets, reach }) => (reach === "wallet" ? [`lets ${lets}`] : [])),
    ...(effect.blind ? [effect.blind] : []),
  ];
}

/**
 * What an action keeps of its effect for the ladder's proof rung (see
 * stepUpReason), so the tap is judged by the card the owner saw: the reasons
 * that hold wherever the money goes, and where money leaving the owner goes.
 */
export function pinnedApproval(effect: Effect): Record<string, string> {
  const needsStepUp = stepUpOnly(effect).join("; ");
  return {
    ...(needsStepUp ? { needsStepUp } : {}),
    ...(leavesYou(effect) ? { leavesTo: (effect.to ?? []).join(",") } : {}),
  };
}

/**
 * Where money leaving the owner goes, from what its action pinned, as a reason
 * for the owner's proof: anywhere Auni can't name, or anywhere not `known`; null when
 * it doesn't leave them, or goes only where they've sent before.
 */
function goesSomewhereNew(
  details: Record<string, string>,
  known: readonly string[],
): string | null {
  if (details.leavesTo === undefined) return null;
  const to = details.leavesTo.split(",").filter(Boolean);
  if (to.length === 0) return "sends money away, and Auni can't say where";
  const fresh = to.filter((each) => !known.some((past) => sameDestination(past, each)));
  return fresh.length > 0
    ? `sends money to ${fresh.map(shortAddress).join(" and ")}, where you've never sent before`
    : null;
}

/**
 * Why a move takes proof the owner is there, from what its action pinned (see
 * pinnedApproval), or null when a tap will do. Every reason is said, since a
 * raw transaction's fresh effect may add none the card didn't (see
 * assertStillAsShown). `known` are the destinations the owner has sent to
 * before: money leaving for anywhere else, or anywhere Auni can't name, needs it.
 */
export function stepUpReason(
  details: Record<string, string>,
  known: readonly string[],
): string | null {
  const reasons = [details.needsStepUp, goesSomewhereNew(details, known)];
  return reasons.filter(Boolean).join("; ") || null;
}

/**
 * Why a move takes proof the owner is there, as its card says it to them: the first reason that
 * holds, in one plain sentence, where stepUpReason says every one of them for the agent. Null
 * when a tap will do. It says only that Auni checks, since how depends on the request the card
 * is allowed by (auth/proof.ts): from a browser paired minutes ago, the tap is enough.
 */
export function stepUpWhy(
  details: Record<string, string>,
  known: readonly string[],
): string | null {
  const so = (why: string) => `${why}, so Auni checks it's you.`;
  if (goesSomewhereNew(details, known))
    return so(
      details.leavesTo
        ? "It goes to an address you've never sent to before"
        : "Nothing comes back for what you send, and Auni can't say where it goes",
    );
  const reasons = details.needsStepUp?.split("; ") ?? [];
  if (reasons.length === 0) return null;
  return so(
    reasons.some((reason) => reason.startsWith("lets "))
      ? "It leaves a permission over your wallet behind"
      : "Auni can't see everything it does by running it first",
  );
}

type Approval = { readonly kind: "proof"; readonly reason: string } | { readonly kind: "tap" };

/**
 * The approval ladder for a person's move, first match wins: proof the owner is
 * there (auth/proof.ts; money leaving for
 * somewhere new, a lasting power over the main wallet to anyone but Auni, or
 * anything a tap can't vouch for); otherwise a tap. What
 * never goes, such as a call to the wallet's own account code, is refused
 * before it has a card. A specialist acting on its own skips the tap only
 * within its pot (see permissionDecision).
 */
export function approval(effect: Effect, known: readonly string[]): Approval {
  const reason = stepUpReason(pinnedApproval(effect), known);
  return reason ? { kind: "proof", reason } : { kind: "tap" };
}

/** Whether a move's money stays the owner's, in their own accounts, with no new power over it. */
export function staysYours(effect: Effect): boolean {
  return !leavesYou(effect) && effect.grants.length === 0 && !effect.blind;
}

/** The same two addresses: EVM's are case-insensitive, Solana's base58 is not. */
export function sameDestination(left: string, right: string): boolean {
  return left.startsWith("0x") && right.startsWith("0x")
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

const worth = ({ text, usd }: Amount) => (usd === undefined ? text : `${text} (${usdLabel(usd)})`);

/** The labels of every card's lines. */
export const LINES = {
  gives: "You give",
  gets: "You get",
  sends: "You send",
  to: "To",
  costs: "Costs",
  lets: "Lets",
} as const;

/**
 * Where money that gets nothing back goes, as a card's line: a send to the address it goes to,
 * whole, since that is what the owner checks before money leaves for good; or, where Auni can't
 * name it (a contract, which may pass it on), that nothing comes back.
 */
export function sentTo(to: readonly string[] | undefined): ActionLine {
  return to?.length
    ? { label: LINES.to, value: to.join(" and ") }
    : { label: LINES.gets, value: "Nothing back" };
}

/**
 * Every card's lines, whatever the venue: You give, You get, Costs, and Lets
 * when it grants a lasting power; money that leaves with nothing back is a send, which says
 * where it goes (see sentTo). The agent reads them too.
 */
export function effectLines(effect: Effect): ActionLine[] {
  const { gives, gets, grants } = effect;
  const got = gets.map((get) => (get.lands ? `${worth(get)} ${get.lands}` : worth(get)));
  const sends = leavesYou(effect);
  const to = sends ? sentTo(effect.to) : null;
  const lines: [string, string | null][] = [
    [sends ? LINES.sends : LINES.gives, gives.map(worth).join(", ") || null],
    ...(to ? [[to.label, to.value] as [string, string]] : []),
    [LINES.gets, got.join(", ") || null],
    [LINES.costs, costsLabel(effect.costs ?? [])],
    [LINES.lets, grants.map(({ lets }) => lets).join(" and ") || null],
  ];
  return lines.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}

/** What several moves cost, each kind summed across them, in the order each first comes. */
export function costsTogether(effects: readonly Effect[]): Cost[] {
  const summed = new Map<string, number>();
  for (const { label, usd } of effects.flatMap((effect) => effect.costs ?? []))
    summed.set(label, (summed.get(label) ?? 0) + usd);
  return [...summed].map(([label, usd]) => ({ label, usd }));
}

/** What a move costs in all, in dollars. */
export function costTotal(costs: readonly Cost[] = []): number {
  return costs.reduce((sum, { usd }) => sum + usd, 0);
}

/**
 * "$0.25 price move", or "$0.65 ($0.25 network fee, $0.40 price move)": each part's dollars
 * first; null for nothing.
 */
export function costsLabel(costs: readonly Cost[]): string | null {
  const parts = costs.map(({ label, usd }) => `${feeLabel(usd)} ${label}`);
  if (parts.length < 2) return parts[0] ?? null;
  return `${feeLabel(costTotal(costs))} (${parts.join(", ")})`;
}
