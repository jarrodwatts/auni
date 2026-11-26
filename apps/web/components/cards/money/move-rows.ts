import {
  APP_LISTINGS,
  appListing,
  NETWORKS,
  type ActionCardWire,
  type ActionPlanLeg,
  type ActionStatus,
  type ActionWire,
  type MoneyFlow,
  SUMMARY_VERBS,
} from "@auni/shared";

import type { Status } from "@/components/motion/status-mark";

import { actionCardContent, cardMark, type MoneyCardMark } from "./action-card-content";
import type { Leg, Move } from "./plan-legs";
import type { Failure } from "./failed-step";
import { amountLabel, closeResult, perpLine, perpTag } from "./pick-money";

/**
 * Every money card tells its moves the same way: one row per thing it does,
 * in the order they run, each waiting, happening now, done or not gone
 * through. This turns a card's moves and picks, read live, into those rows.
 */

/** What a row says at each status: its plain name, then present while it runs and past once done. */
export type Words = Readonly<Record<Status, string>>;

/** A small word beside a row's name: a prediction's side, a perp's bet, or on a mixed card what it does. */
interface Tag {
  readonly text: string;
  readonly tone: "in" | "back" | "plain";
}

export interface MoveRow {
  readonly key: string;
  /** What it's about; null for a single move's steps, which are all about the one thing. */
  readonly logo: MoneyCardMark | null;
  /** Where a move's cash lands, as a small mark on its logo. */
  readonly badge: string | null;
  readonly label: string;
  readonly tags: readonly Tag[];
  /** The quiet line under it: why it's there, or what's at stake. */
  readonly line: string | null;
  /** What a close locks in, said after the line in gain or loss colour. */
  readonly result: { readonly text: string; readonly down: boolean } | null;
  /** On the right: the money it moves, and once a sale fills, what came back. */
  readonly meta: string | null;
  readonly status: Status;
  /** Why it didn't go through, and where the money is now (see failedStep). */
  readonly failure: Failure | null;
  /** The pick behind the row, whose detail opens on hover or tap. */
  readonly pick: Leg | null;
}

const STEP: Omit<MoveRow, "key" | "label" | "status"> = {
  logo: null,
  badge: null,
  tags: [],
  line: null,
  result: null,
  meta: null,
  failure: null,
  pick: null,
};

/**
 * Allowed legs wait their turn: a leg is happening only once core has started it. A held one
 * has stopped and waits on the person, so it is marked as a step that needs them.
 */
function rowStatus({
  status,
  started,
  held,
}: {
  readonly status: ActionStatus;
  readonly started: boolean;
  readonly held: boolean;
}): Status {
  if (status === "done" || status === "failed") return status;
  if (held) return "failed";
  return status === "running" && started ? "now" : "waiting";
}

/**
 * A plan's rows: the moves that get the money ready first,
 * in the order they run, then the picks.
 */
export function moveRows(moves: readonly Move[], legs: readonly Leg[]): MoveRow[] {
  return [...moves.map(moveRow), ...legs.map(pickRow)];
}

const USDC = cardMark({ logoUrl: "/brand/tokens/usdc.svg", logoName: "USDC", venue: "auni" });

/** A move is cash on its way somewhere: USDC, marked with where it lands. */
function moveRow(move: Move): MoveRow {
  const status = rowStatus(move);
  return {
    ...STEP,
    key: move.actionReference,
    logo: USDC,
    badge: move.lands ? placeLogo(move.lands) : null,
    // A held move is named as it was asked: nothing says yet whether it went.
    label: sentenceWords(move.name)[move.held ? "waiting" : status],
    status,
    failure:
      status === "failed"
        ? failureOf(move, `Your money is still in ${move.from ?? "your account"}.`)
        : null,
  };
}

/** A network's mark, or the venue's whose account it is. */
function placeLogo(place: NonNullable<Move["lands"]>): string | null {
  return Object.hasOwn(NETWORKS, place)
    ? NETWORKS[place as keyof typeof NETWORKS].logo
    : (appListing(place)?.logo ?? null);
}

function pickRow(leg: Leg): MoveRow {
  const status = rowStatus(leg);
  const { name, side } = splitSide(leg.name);
  const failed = status === "failed";
  // A close says the bet it lets go of in its line, so its tag never reads as one it opens.
  const bet = leg.perp && !leg.perp.closes ? perpTag(leg.perp) : side;
  // Once it runs its label says what it does, so the word for that goes.
  const verb = leg.verb && status === "waiting" ? leg.verb : null;
  // A perp's line says what's at stake; Auni's take on it is in its detail.
  const reason = leg.perp ? perpLine(leg.perp) : leg.why;
  return {
    ...STEP,
    key: leg.actionReference,
    logo: cardMark(leg),
    label: (leg.words ?? pickWords(leg, name))[leg.held ? "waiting" : status],
    tags: [
      ...(verb ? [{ text: verb, tone: leg.flow === "back" ? "back" : "in" } as const] : []),
      ...(bet ? [{ text: bet, tone: "plain" } as const] : []),
      // Only a pick costing more than a normal trade carries its cost, and only before the tap.
      ...(leg.cost && status === "waiting"
        ? [{ text: `Costs ${leg.cost}`, tone: "plain" } as const]
        : []),
    ],
    line: failed ? null : reason,
    result: failed || !leg.perp ? null : closeResult(leg.perp),
    meta: failed
      ? null
      : amountLabel(BigInt(leg.amount.baseUnits), leg.amount.currency.decimals, leg.flow),
    status,
    failure: failed ? failureOf(leg, STAYED) : null,
    pick: leg,
  };
}

/** Where the money is after a step that spends it in place didn't go through. */
export const STAYED = "Your money stayed where it was.";

/** A step that didn't go through, as core recorded it, and where the money is now. */
export function failureOf(
  item: Pick<Leg, "error" | "failureKind" | "retryable"> & { readonly held?: boolean },
  where: string,
): Failure {
  return {
    kind: item.failureKind,
    said: readableError(item.error),
    where,
    retryable: item.retryable,
    ...(item.held ? { held: true } : {}),
  };
}

const PICK_VERBS = {
  buy: { now: "Buying", done: "Bought", failed: "Didn't buy" },
  sell: { now: "Selling", done: "Sold", failed: "Didn't sell" },
  open: { now: "Opening", done: "Opened", failed: "Didn't open" },
  close: { now: "Closing", done: "Closed", failed: "Didn't close" },
} as const;

/**
 * A pick is named by what it is ("NVIDIA"); while it runs it says what it does to it, in its own
 * card's verbs when its face gave some (a bet), else by which way its money goes.
 */
function pickWords(leg: Pick<Leg, "flow" | "perp" | "verbs">, name: string): Words {
  const verb =
    leg.verbs ??
    PICK_VERBS[leg.flow === "back" ? (leg.perp ? "close" : "sell") : leg.perp ? "open" : "buy"];
  return {
    waiting: name,
    now: `${verb.now} ${name}`,
    done: `${verb.done} ${name}`,
    failed: `${verb.failed} ${name}`,
  };
}

/** Core names a move by what it will do; the verbs those names start with, beyond a card's own. */
const MOVE_VERBS: typeof SUMMARY_VERBS = {
  ...SUMMARY_VERBS,
  Convert: { doing: "Converting", past: "Converted" },
  Take: { doing: "Taking", past: "Took" },
};

/** "Move $30 to Polygon" while it runs is "Moving $30 to Polygon", and once done "Moved $30 to Polygon". */
function sentenceWords(sentence: string): Words {
  const [verb = "", ...rest] = sentence.split(" ");
  const known = MOVE_VERBS[verb];
  if (!known) return { waiting: sentence, now: sentence, done: sentence, failed: sentence };
  const tail = rest.join(" ");
  return {
    waiting: sentence,
    now: `${known.doing} ${tail}`,
    done: `${known.past} ${tail}`,
    failed: didnt(sentence),
  };
}

/** "Buy Nvidia for $50" that didn't go through: "Didn't buy Nvidia for $50". */
export function didnt(title: string): string {
  return `Didn't ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
}

/** Why a move failed, when core said it as a sentence a person can read; null when it didn't. */
function readableError(error: string | null): string | null {
  return error && /^[A-Z][^{}[\]]{0,200}\.$/u.test(error) ? error : null;
}

/** Core names a prediction "Wegovy pill approved: Yes"; the side reads better as a tag. */
function splitSide(name: string): { readonly name: string; readonly side: string | null } {
  const match = /^(.+?):\s*(Yes|No)$/iu.exec(name);
  return match?.[1] && match[2] ? { name: match[1], side: match[2] } : { name, side: null };
}

/**
 * A plan's move as a row: a named pick reads by its asset and why, a
 * prediction reads as its market with the side tagged, and anything else
 * names the move over where it runs, in its own card's words as it runs and
 * once done.
 */
export function planLeg(
  leg: ActionPlanLeg,
): Omit<Leg, "error" | "failureKind" | "retryable" | "started" | "held"> {
  const content = actionCardContent(leg);
  const { pick } = content;
  const named = leg.name !== undefined;
  const name =
    leg.name ?? (pick ? (pick.tag ? `${pick.name}: ${pick.tag}` : pick.name) : content.title);
  const why = leg.why ?? (pick ? content.title : (leg.line ?? ""));
  const note = leg.note ?? (leg.perp && leg.why ? leg.why : undefined);
  const verbs = leg.verbs ?? (!named && pick ? pick.verbs : undefined);
  return {
    actionReference: leg.actionReference,
    name,
    why,
    ...(note ? { note } : {}),
    ...(leg.cost ? { cost: leg.cost } : {}),
    ...(leg.perp ? { perp: leg.perp } : {}),
    ...(verbs ? { verbs } : {}),
    ...(!named && !pick
      ? {
          words: {
            waiting: content.title,
            now: content.working,
            done: content.receipt.title,
            failed: didnt(content.title),
          },
        }
      : {}),
    card: leg.card,
    venue: leg.venue,
    logoUrl: leg.logoUrl,
    // Its initials are what the move is about, never its sentence ("Move $9.50..." isn't "MO").
    logoName: leg.logoName ?? (leg.name ? splitSide(leg.name).name : null),
    amount: leg.amount,
    flow: leg.flow,
    status: leg.status,
  };
}

/**
 * Moves core marks sent before they land, by the transaction it keeps or by
 * where it says the money lands, so the card can tick "Sent" in between.
 * An order on an exchange's own book leaves no such mark, so it ticks only
 * once done.
 */
const SENDS: ReadonlySet<string> = new Set([
  "evm_swap",
  "solana_swap",
  "send_evm_transaction",
  "send_solana_transaction",
  "stock_trade",
  "withdraw_usdc",
  // An app's own, by its meta.
  ...APP_LISTINGS.flatMap(({ tools }) =>
    Object.entries(tools ?? {}).flatMap(([name, tool]) => (tool.sends ? [name] : [])),
  ),
]);

type ActionCard = Pick<ActionCardWire, "tool" | "details">;
type LiveAction = Pick<ActionWire, "status" | "phase" | "txs">;

/**
 * A single move's rows, read only from what core has recorded: allowed, sent
 * (once its transaction has a hash, or core says it is landing), and landed.
 * Labels say the move in the person's words, present while it happens and
 * past once it has.
 */
export function actionRows(
  card: ActionCard,
  live: LiveAction,
  words: { readonly working: string; readonly done: string },
): MoveRow[] {
  const allowed = live.status === "running" || live.status === "done";
  const landed = live.status === "done";
  const tx = live.txs.find((each) => !each.setup);
  // A withdrawal from an app's own ledger has no hash until it lands, but core says it is
  // landing once it's out.
  const sent = landed || !!tx || live.phase === "landing";
  const tracked = SENDS.has(card.tool);
  const steps: { readonly key: string; readonly label: string; readonly done: boolean }[] = [
    { key: "allowed", label: allowed ? "Allowed" : "Allowing", done: allowed },
  ];
  if (tracked) {
    const chain = tx ? chainName(tx.chain) : null;
    steps.push(
      {
        key: "sent",
        label: sent ? (chain ? `Sent on ${chain}` : "Sent") : words.working,
        done: sent,
      },
      { key: "landed", label: landing(card, chain, landed ? words.done : null), done: landed },
    );
  } else {
    steps.push({ key: "landed", label: landed ? words.done : words.working, done: landed });
  }
  const now = steps.findIndex((step) => !step.done);
  return steps.map(({ key, label, done }, index) => ({
    ...STEP,
    key,
    label,
    status: done ? "done" : index === now ? "now" : "waiting",
  }));
}

/**
 * The last stretch. Money crossing to another network stays running until
 * it arrives there, so that step is on its way, then arrived. Anything else
 * confirms where it was sent, then says what it did.
 */
function landing(card: ActionCard, chain: string | null, done: string | null): string {
  const to = destination(card);
  if (to) return done ? `Arrived on ${to}` : `On its way to ${to}`;
  return done ?? (chain ? `Confirming on ${chain}` : "Confirming");
}

/**
 * Where a move that crosses networks arrives, as the move pinned it (`arrivesOn`), or null for
 * one that stays put.
 */
function destination(card: ActionCard): string | null {
  return card.details.arrivesOn ?? null;
}

/** Core's chain keys are lowercase words: "monad" reads "Monad". */
function chainName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The row the soft spotlight rests on: the first happening now, else the first waiting on the person. */
export function spotlit(rows: readonly MoveRow[]): string | null {
  return (
    rows.find((row) => row.status === "now")?.key ??
    rows.find((row) => row.status === "failed")?.key ??
    null
  );
}

/** Past this many rows the rest wait behind one quiet "N more" row, so the card stays a glance. */
const SHOWN = 5;

/**
 * How many rows the list shows before "N more". A row that didn't go through
 * is never behind it, since its reason and what to do about it are there.
 */
export function shownRows(rows: readonly MoveRow[]): number {
  if (rows.length <= SHOWN + 1) return rows.length;
  return rows.slice(SHOWN).some((row) => row.status === "failed") ? rows.length : SHOWN;
}

/** Rows behind "N more" as one mark: busy if any is, done once all are. */
export function overall(rows: readonly MoveRow[]): Status {
  if (rows.some((row) => row.status === "now")) return "now";
  return rows.length > 0 && rows.every((row) => row.status === "done") ? "done" : "waiting";
}

/** Where a card's money is: still to move, moving, or moved. */
type Phase = "before" | "running" | "after";

/**
 * The line under a card's name: its own words before, what it's doing while
 * its money moves, and once it's over, how much of it went through.
 */
export function headerLine({
  done,
  held = 0,
  flow,
  own,
  phase,
  total,
}: {
  /** Picks (or a single move) that went through, of `total`. */
  readonly done: number;
  /** Those held for the person, which neither went through nor didn't. */
  readonly held?: number;
  /** Which way its money goes, or null for a card that moves none. */
  readonly flow: MoneyFlow | null;
  readonly own: string | null;
  readonly phase: Phase;
  readonly total: number;
}): { readonly text: string | null; readonly working: boolean } {
  if (phase === "before") return { text: own, working: false };
  if (phase === "running") {
    const text =
      flow === null
        ? "Working on it"
        : flow === "in"
          ? "Putting your money in"
          : "Moving your money";
    return { text, working: true };
  }
  if (held > 0) {
    const waits = total === 1 ? "Status unknown" : `${held} with status unknown`;
    return {
      text: done > 0 ? `${done} of ${total} went through, ${waits}` : waits,
      working: false,
    };
  }
  const text =
    done === 0
      ? total === 1
        ? "It didn't go through"
        : "None went through"
      : done < total
        ? `${done} of ${total} went through`
        : total === 1
          ? "It went through"
          : `${everyOne(total)} went through`;
  return { text, working: false };
}

/** Every one of `count` things, as said aloud: "Both", "All 5". */
function everyOne(count: number): string {
  return count === 2 ? "Both" : `All ${count}`;
}

/** Under a card's total, what that money does: before, while it moves, and once it has. */
export function amountNote(phase: Phase, flow: "in" | "back", placedNone: boolean): string {
  if (phase === "running") return "on its way";
  if (phase === "before") return flow === "in" ? "to put in" : "coming back";
  if (placedNone) return "not placed";
  return flow === "in" ? "put in" : "back to cash";
}
