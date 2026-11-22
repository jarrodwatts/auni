import type { ActionRow } from "../db/schema.ts";
import { stepUpOnly, sameDestination, type Effect } from "./effect.ts";
import { parseUnits } from "./usd.ts";
import type { Moved, Simulated, TokenLeg } from "./wallet-effect.ts";

// What was allowed stays on the action, so execute never goes past it however
// prices move after the preview: a buy's amountUsd, and a sell's quantity
// under this details key (lowercase, so no card shows it).
export const APPROVED_SALE = "sellsUpTo";
// …and which holding it sells, by fillIdentity, so a card can be found by what it sells.
export const APPROVED_SALE_OF = "sellsHolding";
// …and the least a trade's card said it gets: cash for a sell, the token for a buy.
export const APPROVED_PROCEEDS = "getsAtLeast";
// …and the worst price an order's card was approved at: the most a buy pays, the least a sale gets.
export const APPROVED_PRICE_AT_MOST = "priceAtMost";
export const APPROVED_PRICE_AT_LEAST = "priceAtLeast";
// …and what a raw transaction on a tap sends and gets, as its simulation showed, "token:units,…".
const APPROVED_SENDS = "sendsUpTo";
const APPROVED_GETS = "getsAbout";

export type Approved = Pick<ActionRow, "amountUsd" | "details">;

/**
 * A refusal, with nothing sent, because the price moved past what the person
 * approved: run again as it is, it goes only once the price is back inside.
 */
export class PriceMoved extends Error {}

/** A decimal string exactly enough to compare any two amounts or prices a card pins. */
const exact = (value: string) => parseUnits(value, 36);

/**
 * Whether a step priced again now (see the quote route) stays inside every
 * bound its card pinned: it sells no more and pays no worse a price, and gets
 * no less. A buy's spend is its card's own amount, so it never moves. A bound
 * only one side names isn't compared.
 */
export function insideApproved(
  approved: Pick<ActionRow, "details">,
  fresh: Pick<ActionRow, "details">,
): boolean {
  const within = (key: string, inside: (now: bigint, shown: bigint) => boolean) => {
    const shown = approved.details[key];
    const now = fresh.details[key];
    return shown === undefined || now === undefined || inside(exact(now), exact(shown));
  };
  return (
    [APPROVED_SALE, APPROVED_PRICE_AT_MOST].every((key) =>
      within(key, (now, shown) => now <= shown),
    ) &&
    [APPROVED_PROCEEDS, APPROVED_PRICE_AT_LEAST].every((key) =>
      within(key, (now, shown) => now >= shown),
    )
  );
}

/**
 * The worst price an order goes at now: what the market allows it (`quoted`),
 * held to the worst its card was approved at. Refuses one whose market price
 * (`mark`) is already past that, which couldn't fill inside it. An order
 * whose card pinned no worst price goes as quoted.
 */
export function approvedPrice(
  approved: Pick<ActionRow, "details">,
  { mark, quoted }: { readonly mark: number; readonly quoted: string },
): string {
  // Prices are the venue's floats, as the order itself is priced.
  const most = approved.details[APPROVED_PRICE_AT_MOST];
  const least = approved.details[APPROVED_PRICE_AT_LEAST];
  if ((most !== undefined && mark > Number(most)) || (least !== undefined && mark < Number(least)))
    throw new PriceMoved(
      "The price moved past the worst this was approved at, so nothing was sent.",
    );
  if (most !== undefined && Number(quoted) > Number(most)) return most;
  if (least !== undefined && Number(quoted) < Number(least)) return least;
  return quoted;
}

/**
 * The exact token a trade's card showed, by address or mint, under its
 * details `key`: execute trades it rather than looking a name up again, which
 * could come to mean another token by then.
 */
export function pinnedToken(approved: Approved, key: string): string {
  const token = approved.details[key];
  if (!token)
    throw new Error("This card doesn't say exactly which token it trades. Nothing was sent.");
  return token;
}

/** Refuses a sell of more than was allowed, in the holding's base units. */
export function assertApprovedSale(approved: Approved, units: bigint, decimals: number): void {
  const quantity = approved.details[APPROVED_SALE];
  if (quantity !== undefined && units > parseUnits(quantity, decimals)) {
    throw new PriceMoved(
      "The price moved since this was approved, so it would sell more than was allowed. Nothing was sent.",
    );
  }
}

/**
 * Refuses `units` of what a trade gets, in its base units, that fall under
 * what its card said it gets at least: the price fell, or the market thinned,
 * since it was approved.
 */
export function assertApprovedProceeds(approved: Approved, units: bigint, decimals: number): void {
  const floor = approved.details[APPROVED_PROCEEDS];
  if (floor !== undefined && units < parseUnits(floor, decimals)) {
    throw new PriceMoved(
      "The price moved since this was approved, so it would get less than was shown. Nothing was sent.",
    );
  }
}

/**
 * Builds a swap whose transaction itself holds what its card said it gets at
 * least: `build` quotes it at a slippage, and `paid` reads what that quote
 * expects and the least its transaction lets land. A swap's least sits one
 * slippage under what it expects, so once the price falls at all since the
 * card, a fresh quote at the card's slippage would let less land than was
 * shown. It is built again with the slippage narrowed to keep the card's
 * least, and nothing goes once even what it expects falls under that. Every
 * swap's card pins its least, so one that didn't has nothing to hold its
 * transaction to, and nothing goes.
 */
export async function quoteHoldingProceeds<Quote>(
  approved: Approved,
  decimals: number,
  slippageBps: number,
  build: (slippageBps: number) => Promise<Quote>,
  paid: (quote: Quote) => { readonly expected: bigint; readonly least: bigint },
): Promise<Quote> {
  const floor = approved.details[APPROVED_PROCEEDS];
  if (floor === undefined)
    throw new Error("This card doesn't say the least it gets. Nothing was sent.");
  const quote = await build(slippageBps);
  const shown = parseUnits(floor, decimals);
  const { expected, least } = paid(quote);
  if (least >= shown) return quote;
  assertApprovedProceeds(approved, expected, decimals);
  // Rounded down, so the least it lets land rounds up past what was shown.
  const narrowed = Number(((expected - shown) * 10_000n) / expected);
  const held = await build(Math.min(slippageBps, narrowed));
  assertApprovedProceeds(approved, paid(held).least, decimals);
  return held;
}

/** Refuses a buy that spends more USDC base units than was allowed, past its own slippage bound. */
export function assertApprovedSpend(approved: Approved, usdcUnits: bigint, slippageBps = 0): void {
  const allowed = (parseUnits(approved.amountUsd, 6) * BigInt(10_000 + slippageBps)) / 10_000n;
  if (usdcUnits > allowed) {
    throw new PriceMoved(
      "The price moved since this was approved, so it would spend more than was allowed. Nothing was sent.",
    );
  }
}

/** What a raw transaction's card showed leaving and arriving: a tap holds its execute to it. */
export function approvedEffect(effect: Moved): Record<string, string> {
  const text = (legs: readonly TokenLeg[]) =>
    legs.map(({ token, amount }) => `${token}:${amount}`).join(",");
  return { [APPROVED_SENDS]: text(effect.out), [APPROVED_GETS]: text(effect.in) };
}

/** Whether a raw transaction's card showed assets moving, which it records as fills. */
export function showedAssetsMoving(approved: Pick<ActionRow, "details">): boolean {
  return Boolean(approved.details[APPROVED_SENDS] || approved.details[APPROVED_GETS]);
}

/** What a raw transaction's card showed under one key, by token as the simulation named it. */
function shownLegs(approved: Pick<ActionRow, "details">, key: string): TokenLeg[] {
  return ((approved.details[key] || null)?.split(",") ?? []).map((pair) => {
    const [token = "", units = "0"] = pair.split(":");
    return { token, amount: BigInt(units) };
  });
}

/** What a raw transaction's card showed leaving and arriving; null for one drawn without a simulation. */
export function approvedMoved(approved: Pick<ActionRow, "details">): Moved | null {
  if (!(APPROVED_SENDS in approved.details)) return null;
  return { out: shownLegs(approved, APPROVED_SENDS), in: shownLegs(approved, APPROVED_GETS) };
}

/** The tokens a raw transaction's card showed it sending and getting; null for one drawn without a simulation. */
export function approvedTokens(
  approved: Pick<ActionRow, "details">,
): { readonly sends: string[]; readonly gets: string[] } | null {
  const shown = approvedMoved(approved);
  return (
    shown && {
      sends: shown.out.map(({ token }) => token),
      gets: shown.in.map(({ token }) => token),
    }
  );
}

/**
 * What Auni asks of bytes someone else built: send at most `gives` of each
 * token and nothing else, and land at least `gets` of each in the wallet.
 */
interface Asked {
  readonly gives: readonly TokenLeg[];
  readonly gets: readonly TokenLeg[];
}

const unitsOf = (legs: readonly TokenLeg[], token: string) =>
  legs.find((leg) => sameDestination(leg.token, token))?.amount ?? 0n;

/** Refuses a simulation that couldn't run, or that moves more or gets less than was asked. */
function assertMoves(now: Simulated | null, asked: Asked): asserts now is Simulated {
  if (!now)
    throw new Error(
      "Auni couldn't check this in a simulation just now, so nothing was sent. Try again in a moment.",
    );
  if (now.out.some(({ token, amount }) => amount > unitsOf(asked.gives, token)))
    throw new Error("It would send more than was shown, so nothing was sent.");
  if (asked.gets.some(({ token, amount }) => unitsOf(now.in, token) < amount))
    throw new Error("It would get less into your wallet than was shown, so nothing was sent.");
}

/**
 * Refuses bytes someone else built (a route, a bridge's calldata) unless their
 * simulation from the owner's wallet does what was asked of them (see Asked)
 * and nothing more: whoever built them could have them pay out somewhere
 * else, take more, or leave a permission behind, and the card showed none of
 * that. Null is a simulation that couldn't run, and nothing unchecked is signed.
 */
export function assertBytesDo(now: Simulated | null, asked: Asked): void {
  assertMoves(now, asked);
  if (now.grants.length > 0)
    throw new Error("It would leave a permission over your money behind, so nothing was sent.");
}

/**
 * Refuses a raw transaction whose fresh effect strays from what its card
 * showed, whether a tap alone or one with the owner's proof approved it: either vouched only
 * for what was shown. Nothing new may need that proof (see pinnedApproval),
 * which covers every permission it leaves; money leaving the owner may go only
 * where its card named; and nothing may leave past what the card showed.
 * The agent's bytes state no least they get, so what the card showed arriving may
 * come in up to 3% under, as the chain moves between the card and the send. A
 * card drawn without a simulation showed no amounts to hold it to, and took the owner's proof.
 */
export function assertStillAsShown(approved: Approved, fresh: Effect, now: Simulated | null): void {
  const shownReasons = approved.details.needsStepUp?.split("; ") ?? [];
  const reason = stepUpOnly(fresh).find((each) => !shownReasons.includes(each));
  if (reason) throw new Error(`This now ${reason}, so nothing was sent.`);
  const shownTo = approved.details.leavesTo?.split(",").filter(Boolean) ?? [];
  if (
    shownTo.length > 0 &&
    (!fresh.to || fresh.to.some((to) => !shownTo.some((each) => sameDestination(each, to))))
  )
    throw new Error("It would send money somewhere its card didn't show, so nothing was sent.");
  if (!(APPROVED_SENDS in approved.details)) return;
  assertMoves(now, {
    gives: shownLegs(approved, APPROVED_SENDS),
    gets: shownLegs(approved, APPROVED_GETS).map(({ token, amount }) => ({
      token,
      amount: (amount * 97n + 99n) / 100n,
    })),
  });
}
