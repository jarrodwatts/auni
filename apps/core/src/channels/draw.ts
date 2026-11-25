import { createHash } from "node:crypto";

import {
  ASK_DONE,
  HELD_SAFE,
  isAsk,
  storedSuggestRepliesSchema,
  type CardWire,
} from "@auni/shared";

import type { ActionRow, ChannelQuestion } from "../db/schema.ts";
import type { ChannelButton, ChannelMessage } from "../apps/contract.ts";
import { pricedLater } from "../money/action-card.ts";
import { LINES } from "../money/effect.ts";
import { feeCoinsSaid } from "../money/fee-coin-said.ts";

// What the hub sends on a channel, drawn from core's own records: a card's words and buttons come
// from its action rows, never from anything the agent wrote, and only the hub puts a grant on a
// button. A message is Markdown, but a card's words came from outside (a token's or a market's
// name, a service's error), so each is drawn as `literal` words that no mark in them can format.

/** The marks Markdown reads as formatting, each drawn as itself once a backslash precedes it. */
const MARKS = /[\\`*_~#[\]()<>]/gu;

/**
 * Words from outside as Markdown that shows them exactly: every mark escaped, so a name such as
 * "[Claim](a link)" or "**FREE**" reads as typed and never becomes a link or bold, and on one
 * line, so it can never pass for a line of the card's own.
 */
export function literal(words: string): string {
  return words.replace(/\s*[\r\n\u2028\u2029]+\s*/gu, " ").replace(MARKS, "\\$&");
}

/** A card about no money, as a channel shows it: its title, and the way to it in the app. */
export function drawLink(title: string, link: string): ChannelMessage {
  return { text: `**${literal(title)}**`, buttons: [[{ label: "Open in the app", url: link }]] };
}

/** A card as one message shows it. */
export interface CardView {
  /** Its one move, or every leg of its proposal, in order. */
  readonly legs: readonly ActionRow[];
  /**
   * It waits on the owner's proof (or a step only the app shows), or is too long to show here in full, so
   * it is decided in the app.
   */
  readonly inTheApp: boolean;
  /** It asks for a secret, which is pasted only in the app. */
  readonly secret?: boolean;
  /** Once decided after it waited here: "here", another channel's name, or "the app". */
  readonly decidedIn: string | null;
  /** The web page the card is on. */
  readonly link: string;
}

export const waitingOn = (legs: readonly Pick<ActionRow, "status">[]): boolean =>
  legs.some((leg) => leg.status === "awaiting_permission");

/** The buttons' grant stands in by this while working out whether a message changed. */
const SOME_GRANT = "grant";

/**
 * A card is one message, kept in step by editing it, so it is never drawn longer than a chat
 * message holds: Telegram's is 4,096 characters, less what its formatting adds. One whose words
 * won't fit (a long routine, say) shows only its summary here and is allowed in the app, where
 * all of it shows, since a tap here would agree to words it never showed.
 */
const CARD_CHARS = 3_000;

/**
 * A card's words in full: its one move's summary and lines, or one line for each leg. While it
 * waits for the tap it also says, in core's own line, what its moves spend on the coins their
 * network fees are paid in (feeCoinsSaid), since Allow here signs that too, and that a trade
 * waiting on a plan's money moves is priced again when its turn comes.
 */
function wholeCard(legs: readonly ActionRow[]): string[] {
  const [only] = legs;
  const waiting = legs.filter((leg) => leg.status === "awaiting_permission");
  const fees = feeCoinsSaid(waiting);
  const said = fees ? [literal(fees)] : [];
  if (legs.length === 1 && only)
    return [
      `**${literal(only.summary)}**`,
      ...only.lines.map((line) => `${literal(line.label)}: ${literal(line.value)}`),
      ...said,
      legStatus(only),
    ];
  // A trade waiting on the plan's money moves is priced again when its turn comes, said before the tap.
  const later = waiting.length > 0 ? pricedLater(legs) : null;
  const together = planHead(legs).length > 1;
  return [
    ...planHead(legs),
    // Each waiting leg's permissions too, as a lone move's lines say them, since Allow here
    // grants them; once decided, where it stands is what the plan says, as the app's does.
    ...legs.flatMap((leg, index) => [
      `${index + 1}. ${literal(leg.summary)}${together ? "" : `: ${legStatus(leg)}`}`,
      ...(leg.status === "awaiting_permission"
        ? leg.lines
            .filter(({ label }) => label === LINES.lets)
            .map((line) => `${literal(line.label)}: ${literal(line.value)}`)
        : []),
    ]),
    ...said,
    ...(later ? [literal(later)] : []),
  ];
}

/**
 * What says what a plan is and where it stands, which one too long to show whole keeps: one tap
 * for all of its moves while it waits, and after, where every move stands when all stand alike
 * (taken back together, say), said once rather than on each.
 */
function planHead(legs: readonly ActionRow[]): string[] {
  if (waitingOn(legs)) return [`**A plan of ${legs.length} moves, one tap for all of them**`];
  const [first, ...rest] = legs.map(legStatus);
  const alike = first !== undefined && rest.every((status) => status === first);
  return [`**A plan of ${legs.length} moves**`, ...(alike ? [first] : [])];
}

/** Whether every word of the card fits its one message; one that doesn't is decided in the app. */
export const fitsHere = (legs: readonly ActionRow[]): boolean =>
  wholeCard(legs).join("\n").length <= CARD_CHARS;

/**
 * A card's message. `grant` goes on Allow and Decline while it waits for a tap here; a card that
 * waits on the app links there instead.
 */
export function drawCard(view: CardView, grant: string | null): ChannelMessage {
  const { legs } = view;
  const waiting = waitingOn(legs);
  const [only] = legs;
  const full = wholeCard(legs);
  const whole = fitsHere(legs);
  // Too long, it keeps what says what the card is and where it stands; a decided plan whose moves
  // stand apart says where to see each.
  const head = planHead(legs);
  const apart = !whole && !waiting && legs.length > 1 && head.length === 1;
  const body = whole
    ? full
    : legs.length === 1 && only
      ? [full[0]!, legStatus(only)]
      : [
          ...head,
          ...(apart ? ["It's too long to show here in full: the app shows each move."] : []),
        ];
  const said = waiting
    ? view.inTheApp
      ? [
          view.secret
            ? "Paste it in the app, where it goes straight to Auni. Never paste it in a chat."
            : whole
              ? "This one is allowed in the app, where Auni can check it's you or a step comes first."
              : "It's too long to show here in full, so it's allowed in the app, where all of it shows.",
        ]
      : []
    : decided(legs, view.decidedIn);
  // A held move is checked again or closed in the app: neither tap has a grant here.
  const held = legs.some((leg) => leg.phase === "needs_owner");
  const buttons: ChannelButton[][] =
    (waiting && view.inTheApp) || held || apart
      ? [[{ label: "Open in the app", url: view.link }]]
      : waiting && grant
        ? [
            [
              { label: "Allow", press: `allow:${grant}` },
              { label: "Decline", press: `decline:${grant}` },
            ],
          ]
        : [];
  return { text: [...body, ...said].join("\n"), ...(buttons.length ? { buttons } : {}) };
}

/** What a card's message shows, as a digest, whichever grant its buttons carry. */
export function shownKey(view: CardView, digest: string): string {
  const drawn = drawCard(view, waitingOn(view.legs) && !view.inTheApp ? SOME_GRANT : null);
  return createHash("sha256")
    .update(JSON.stringify([drawn, digest]))
    .digest("hex");
}

function legStatus(leg: ActionRow): string {
  switch (leg.status) {
    case "awaiting_permission":
      return "Waiting for you";
    case "running":
      if (leg.phase === "queued") return "Starting";
      // Held: why, in core's own words (HELD), what is safe, and where its two taps are.
      if (leg.phase === "needs_owner")
        return `Not confirmed: ${literal(leg.error ?? "")} ${HELD_SAFE} Check it again or close it in the app.`;
      if (leg.phase === "landing") return "Sent, on its way";
      return leg.txs.some((tx) => tx.hash) ? "Sent" : "Running";
    case "done":
      if (isAsk(leg.tool)) return ASK_DONE[leg.tool];
      return leg.run.lands ? "Landed" : "Done";
    case "failed":
      return leg.error ? `Didn't go through: ${literal(leg.error)}` : "Didn't go through";
    case "cancelled":
      return "Declined";
    case "replaced":
      return "Replaced by a newer card";
    case "retracted":
      return literal(leg.error ?? "Taken back by Auni");
  }
}

/** Where a card that waited was decided; nothing for one replaced or taken back undecided. */
function decided(legs: readonly ActionRow[], where: string | null): string[] {
  if (where === null || legs.every(({ status }) => status === "replaced" || status === "retracted"))
    return [];
  const verb = legs.every((leg) => leg.status === "cancelled") ? "Declined" : "Allowed";
  return [where === "here" ? `${verb} here.` : `${verb} in ${where}.`];
}

/** A question with its answers as buttons, or with the answer the owner picked. */
export function drawQuestion(question: ChannelQuestion, answered?: string): ChannelMessage {
  if (answered !== undefined) return { text: `${question.text}\n\nYou answered: ${answered}` };
  return {
    text: question.text,
    buttons: question.options.map((label, index) => [{ label, press: `reply:${index}` }]),
  };
}

/** An answer as a channel sends it: its words, cards and question, in the order they came. */
type Segment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "card"; readonly card: CardWire }
  | { readonly kind: "question"; readonly question: ChannelQuestion };

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly state?: string;
  readonly input?: unknown;
  readonly data?: { readonly cards?: readonly CardWire[] };
}

/**
 * An answer's parts as messages: its text between cards as one message each, every card core
 * sealed (only those reach a stored answer as data-cards), and each question it finished asking.
 */
export function replySegments(parts: readonly unknown[]): Segment[] {
  const segments: Segment[] = [];
  // Each text part is a block of its own, as the web app shows it.
  let blocks: string[] = [];
  const flush = () => {
    const text = blocks
      .map((block) => block.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) segments.push({ kind: "text", text });
    blocks = [];
  };
  for (const part of parts as Part[]) {
    if (part.type === "text" && typeof part.text === "string") blocks.push(part.text);
    else if (part.type === "data-cards") {
      flush();
      for (const card of part.data?.cards ?? []) segments.push({ kind: "card", card });
    } else if (part.type === "tool-suggest_replies" && part.state === "output-available") {
      const asked = storedSuggestRepliesSchema.safeParse(part.input);
      if (!asked.success) continue;
      flush();
      segments.push({
        kind: "question",
        question: {
          // Offered with no question, they are what the owner might say next.
          text: asked.data.question ?? "What next?",
          options: asked.data.options.map((option) => option.label),
        },
      });
    }
  }
  flush();
  return segments;
}
