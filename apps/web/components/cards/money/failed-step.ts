import { HELD_SAFE, type ActionQuoteWire, type FailureKind, type HeldWhy } from "@auni/shared";

/**
 * A step that didn't go through says why in one plain line, with where the
 * money is, beside the one thing that can help: try it again, add money, or
 * ask Auni. Core records why it stopped (its failure kind), and runs a failed
 * step again only when that is safe (see core's retry.ts).
 */

/**
 * What a person can do about a step that didn't go through, or about a held one: have Auni
 * check it again, or close it, which asks once more first (`keep` takes that back).
 */
export type FailedAction = "retry" | "add_money" | "ask" | "check" | "close" | "keep";

/**
 * Whether an action is offered only under the conversation's newest turn. Try again, and a held
 * step's Check again and Close, belong to the move: they stay until the move settles, however
 * much was said after it. Adding money and asking Auni are the conversation's next step, and once
 * something later follows the card, that is where the conversation went on.
 */
export function onlyWhileNewest(action: FailedAction): boolean {
  return action === "add_money" || action === "ask";
}

/** A step that didn't go through, as its card read it. */
export interface Failure {
  /** Why core says it stopped; null reads as unknown. */
  readonly kind: FailureKind | null;
  /** Core's own words for it, when a person can read them. */
  readonly said: string | null;
  /** Where the money is now: "Your money is still in Monad." */
  readonly where: string;
  /** Whether core runs it again on a tap, as it judged by what the step recorded. */
  readonly retryable: boolean;
  /**
   * Held: it hasn't failed, it stopped where Auni can't tell what it did (core's HELD), and
   * `said` is why. It offers Check again and Close in place of anything that would send it again.
   */
  readonly held?: boolean;
}

export interface FailedStep {
  readonly reason: string;
  /** What to offer, most helpful first; empty when nothing here can help. */
  readonly actions: readonly FailedAction[];
}

/**
 * The reason and next steps for a step that didn't go through. A price that
 * moved is weighed by a fresh quote (null until it's read): back inside what
 * was approved, it can simply run again; past it, only Auni can offer new
 * terms. `canAsk` is false where Auni can't be asked from (an older turn).
 */
export function failedStep(
  failure: Failure,
  quote: Pick<ActionQuoteWire, "inside" | "price"> | null,
  canAsk: boolean,
  /** The owner tapped Close on this held step and hasn't said yes yet. */
  closing = false,
): FailedStep {
  const { reason, actions } = failure.held ? held(failure, closing) : byKind(failure, quote);
  return {
    reason,
    actions: actions.filter(
      (action) => (action !== "retry" || failure.retryable) && (action !== "ask" || canAsk),
    ),
  };
}

/** What closing a held step means, asked once before it does. */
const CLOSING =
  "Dismiss this card? Auni stops checking on it and records nothing more. Whatever happened still shows in your balance.";

/**
 * How a held move's card heads where it stands, by why core holds it (HELD): one whose money
 * moved says so, and that only what came back is unread; an order its venue never answered waits
 * on that venue; anything else isn't confirmed yet. `note` goes under its amount.
 */
export function heldHeading(
  why: HeldWhy | (string & {}) | undefined,
  venue: string | null,
): { readonly title: string; readonly badge: string; readonly note: string } {
  if (why === "unrecorded") return { title: "Money moved", badge: "Fill not read", note: "moved" };
  return {
    title: why === "unanswered" && venue ? `Waiting on ${venue}` : "Not confirmed yet",
    badge: "Status unknown",
    note: "status unknown",
  };
}

/** What a Check status that found nothing new says, in place of why it is held. */
export function stillHeld(why: HeldWhy | (string & {}) | undefined): string {
  return why === "unrecorded"
    ? "Still can't read what came back. Auni keeps checking by itself."
    : "Still no answer. Auni keeps checking by itself.";
}

/** A held step: why, in core's words, and what stays true; or, once Close was tapped, what closing means. */
function held({ said }: Failure, closing: boolean): FailedStep {
  if (closing) return { reason: CLOSING, actions: ["keep", "close"] };
  return {
    reason: `${said ?? "Auni couldn't confirm this one."} ${HELD_SAFE}`,
    actions: ["check", "close", "ask"],
  };
}

function byKind(
  { kind, said, where, retryable }: Failure,
  quote: Pick<ActionQuoteWire, "inside" | "price"> | null,
): FailedStep {
  switch (kind) {
    // Core's own sentence says more than the kind can, where it gave one a person can read: a
    // service's refusal as its app words it ("There isn't enough free cash in your account").
    case "funds":
      return {
        reason: `${said ?? "There wasn't enough money for it."} ${where}`,
        actions: ["add_money", "ask"],
      };
    case "glitch":
      return { reason: `A network blip stopped it. ${where}`, actions: ["retry", "ask"] };
    case "busy":
      return { reason: `${said ?? "The venue was busy."} ${where}`, actions: ["retry", "ask"] };
    case "price":
      // Core won't run it again, such as one that ran again on a fresh quote and failed on its price.
      if (!retryable)
        return {
          reason: `The price moved, and this one needs a fresh card from Auni to go. ${where}`,
          actions: ["ask"],
        };
      // A fresh quote can be inside and the route still fail, so Try again says it checks first.
      if (quote?.inside)
        return {
          reason: `The price moved, and it's back inside what you allowed. Try again checks it first and sends nothing if it would still fail. ${where}`,
          actions: ["retry", "ask"],
        };
      return {
        reason: `The price moved past what you allowed${quote?.price ? `, to ${quote.price}` : ""}. ${where}`,
        actions: ["ask"],
      };
    case "rule":
      return {
        reason: `${said ?? "The venue wouldn't take it as it was."} ${where}`,
        actions: ["ask"],
      };
    case "unfilled":
      // Its sends stay on its record, so a fresh card from Auni trades it again, not a rerun.
      return { reason: `${said ?? "No one filled the order."} ${where}`, actions: ["ask"] };
    case "fees":
      // The coin its card bought for the network fee isn't there. Core's sentence says where
      // what paid for it is now, so nothing here says the money stayed put. The card never
      // buys again, so running the move again is safe and goes once the coin has come.
      return {
        reason:
          said ??
          "The coin this card bought for its network fee hasn't arrived, so the move wasn't sent. Trying again buys nothing more.",
        actions: ["retry", "ask"],
      };
    case "sent":
      // Something left, or may have, so where the money is now is for a person to check, not to guess.
      return {
        reason:
          "Part of it may have gone out, so Auni won't send it again. Ask Auni where your money is.",
        actions: ["ask"],
      };
    case "stopped":
      // Where its money is, the move it waited on says, along with why and a Try again that runs
      // this with it: it may never have reached where this one would have spent it from.
      return {
        reason: "Skipped, since the money for it couldn't be moved first. Nothing was spent.",
        actions: [],
      };
    case "unshown":
      // Core's sentence says where its cash is now, which the moves before it may have moved, and
      // Auni puts it up again itself on a fresh card, so there is nothing to tap here.
      return {
        reason:
          said ??
          "Paused before sending: its card didn't show a permission it leaves. Auni will put it up again.",
        actions: [],
      };
    case "unknown":
    case null:
      return { reason: `${said ?? "It didn't go through."} ${where}`, actions: ["retry", "ask"] };
  }
}

/**
 * Whether a step that didn't go through is worth writing up for Auni's maintainers: one that
 * failed in a way that may be Auni's fault or an app's. Never a price that moved, money that
 * wasn't there, a busy venue or a blip, which are nobody's bug.
 */
export function reportable(kind: FailureKind | null): boolean {
  return (
    kind === null || kind === "unknown" || kind === "rule" || kind === "unfilled" || kind === "sent"
  );
}

/**
 * Each action once, on the first row that offers it: one Try again on a card
 * runs every step there that can run again, and one ask is enough.
 */
export function placedActions(
  steps: readonly (readonly [string, FailedStep])[],
): Map<string, readonly FailedAction[]> {
  const offered = new Set<FailedAction>();
  return new Map(
    steps.map(([key, step]) => {
      const fresh = step.actions.filter((action) => !offered.has(action));
      for (const action of fresh) offered.add(action);
      return [key, fresh];
    }),
  );
}

/** How many steps wait on the person: each that didn't go through and offers something to do. */
export function needingYou(steps: Iterable<FailedStep>): number {
  return [...steps].filter((step) => step.actions.length > 0).length;
}

/** "1 needs you", "2 need you". */
export function needsYouLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/** What a tap on Check status or Dismiss card that got no answer says. */
export const HELD_TAP_FAILED = "Couldn't reach Auni. Try again.";

/**
 * What a tap on Try again that didn't run says, by core's answer; null when
 * there's nothing to say because the card already shows where it is now.
 */
export function retryProblem(code: string | null): string | null {
  switch (code) {
    case "not_failed":
      return null;
    case "short_of_money":
      return "There isn't enough money there for it now. Nothing moved.";
    case "not_retryable":
    case "needs_proof":
      return "This one can't be tried again as it is. Nothing moved.";
    default:
      return "Couldn't confirm that reached Auni. Trying again won't send it twice.";
  }
}

/**
 * What the owner asks Auni from a step that didn't go through, in their own bubble: the row's
 * own words, quoted ("Didn't buy NVIDIA"), then the question. No id of the move is in it: a
 * person never says one, and Auni knows the move by those words and by what woke it.
 */
export function askAbout(label: string, reason: string, held = false): string {
  return `"${label}. ${reason}" ${held ? "What happened, and where can I look?" : "What can I do instead?"}`;
}
