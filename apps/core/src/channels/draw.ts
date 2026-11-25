import { createHash } from "node:crypto";

import {
  AMOUNT,
  ASK_DONE,
  filledUsd,
  NETWORKS,
  isAsk,
  storedSuggestRepliesSchema,
  type CardWire,
} from "@auni/shared";

import type { ActionRow, ChannelQuestion } from "../db/schema.ts";
import type { ChannelButton, ChannelMessage, WalletAddresses } from "../apps/contract.ts";
import { planAction, pricedLater } from "../money/action-card.ts";
import { explorerTx } from "../money/chains.ts";
import { feeCoinsSaid } from "../money/fee-coin-said.ts";
import { cardMoneys, rowMoney } from "../money/recipes/index.ts";
import { dollars, moneyLine } from "../money/summaries.ts";
import { parseUnits, sumUsd } from "../money/usd.ts";

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

interface AppDestination {
  readonly link: string | null;
  readonly machine?: string;
}

function viaApp(where: AppDestination, label: string, task: string): ChannelMessage {
  if (where.link) return { text: task, buttons: [[{ label, url: where.link }]] };
  const place = where.machine ? `on ${literal(where.machine)}` : "on your computer";
  return { text: `Open Auni ${place} to ${task}.` };
}

/** A card about no money, as a channel shows it: its title, and the way to it in the app. */
export function drawLink(title: string, link: string | null, machine?: string): ChannelMessage {
  const { text, buttons } = viaApp({ link, machine }, "Open in Auni", "see more");
  return {
    text: `**${literal(title)}**\n\n${link ? "" : text}`.trimEnd(),
    ...(buttons && { buttons }),
  };
}

/** A card as one message shows it. */
export interface CardView extends AppDestination {
  readonly legs: readonly ActionRow[];
  /** It takes proof, needs a private field, or is too long to review here in full. */
  readonly inTheApp: boolean;
  readonly proof?: boolean;
  readonly secret?: boolean;
  readonly decidedIn: string | null;
  readonly threadName?: string | null;
}

export const waitingOn = (legs: readonly Pick<ActionRow, "status">[]): boolean =>
  legs.some((leg) => leg.status === "awaiting_permission");

/** The buttons' grant stands in by this while working out whether a message changed. */
const SOME_GRANT = "grant";
const REVIEW_LAYOUT = "review-v2:";

/** Earlier plan messages showed only summaries of the legs. */
export function showsFullReview(shown: string | null): boolean {
  return shown?.startsWith(REVIEW_LAYOUT) ?? false;
}

/** Leave room for headings, state and formatting in Telegram's 4096-character limit. */
const CARD_CHARS = 3_000;
const quote = (lines: readonly string[]) => lines.map((line) => `> ${line}`).join("\n");
/** A card title or keyboard label always occupies one line. */
const singleLine = (text: string) => text.replace(/\s+/gu, " ").trim();

function faceWords(leg: ActionRow, text: string): string {
  const money = rowMoney(leg);
  return text.replaceAll(AMOUNT, dollars(money?.usd ?? "0"));
}

function planName(legs: readonly ActionRow[]): string {
  const money = moneyLine(cardMoneys(legs));
  return `${legs.length} moves${money ? ` (${money})` : ""}`;
}

function actionLabel(legs: readonly ActionRow[]): string {
  const [leg] = legs;
  if (legs.length === 1 && leg) {
    const action = leg.card?.action;
    if (!action || action === "Confirm" || action === "Allow") return singleLine(leg.summary);
    const money = rowMoney(leg);
    const label = faceWords(leg, action);
    return singleLine(
      money && money.flow !== "back" && !label.includes("$")
        ? `${label} (${dollars(money.usd)})`
        : label,
    );
  }
  const money = cardMoneys(legs);
  const label = planAction(
    legs.map((row, index) => ({
      card: { action: row.card?.action ?? row.summary },
      flow: money[index]?.flow ?? "in",
      amount: {
        baseUnits: parseUnits(money[index]?.usd ?? "0", 6).toString(),
        currency: { code: "USDC", decimals: 6 },
      },
      movesCash: rowMoney(row)?.flow === "move",
    })),
  );
  const total = dollars(
    sumUsd(money.flatMap((amount) => (amount?.flow === "in" ? [amount.usd] : []))),
  );
  return singleLine(label.replaceAll(AMOUNT, total));
}

function reviewLines(leg: ActionRow): string[] {
  const { card } = leg;
  const lines = leg.lines.map(({ label, value }) => `${literal(label)}: ${literal(value)}`);
  if (!card) return lines;
  const figures = card.figures.map(
    ({ label, value, note }) =>
      `${literal(label)}: ${literal(faceWords(leg, value))}${note ? ` (${literal(note)})` : ""}`,
  );
  return [
    ...new Set([
      ...(card.context ? [literal(card.context)] : []),
      ...(card.scene
        ? [literal(`${card.scene.sends} from ${card.scene.from} to ${card.scene.to}`)]
        : []),
      ...(card.checks ? [literal(card.checks.checked)] : []),
      ...lines,
      ...figures,
      ...[card.finePrint, card.warning, card.checks?.why].flatMap((line) =>
        line ? [literal(line)] : [],
      ),
    ]),
  ];
}

function receipt(leg: ActionRow): string | null {
  if (leg.status !== "done" || leg.error || isAsk(leg.tool) || leg.run.settledBy === "owner")
    return null;
  if (leg.run.filled) return leg.run.filled;
  if (leg.run.lands) return `Landed: ${leg.run.lands}`;
  const face = leg.card?.receipt;
  const actual = filledUsd(leg.run);
  if (!face || !actual) return null;
  return [face.title, `${dollars(actual)}${face.amount === "back" ? " back" : ""}`, face.detail]
    .filter(Boolean)
    .join("\n");
}

function cardText(legs: readonly ActionRow[], whole: boolean): string {
  const title = `**${literal(planName(legs))}**`;
  if (legs.length > 1 && !whole) {
    const counts = Map.groupBy(legs, (leg) => legStatus(leg, false));
    return [
      title,
      quote([...counts].map(([status, group]) => `${status.replace(/\.$/u, "")}: ${group.length}`)),
    ].join("\n");
  }
  const one = legs.length === 1 ? legs[0] : undefined;
  const text = legs.map((leg, index) => {
    const filled = whole ? receipt(leg) : null;
    const [title, ...detail] = filled?.split("\n") ?? [];
    const heading = title ?? (leg.card ? faceWords(leg, leg.card.title) : leg.summary);
    const prefix = one ? "" : `${index + 1}. `;
    const facts = whole ? (filled ? detail.map(literal) : reviewLines(leg)) : [];
    const state = filled ? "" : legStatus(leg, whole);
    return [
      `**${prefix}${literal(heading.slice(0, whole ? heading.length : 250))}**`,
      quote(facts),
      state,
    ]
      .filter(Boolean)
      .join("\n");
  });
  if (one) return text[0]!;
  return [title, ...text].join("\n\n");
}

function tapNotes(legs: readonly ActionRow[]): string {
  const waiting = legs.filter((leg) => leg.status === "awaiting_permission");
  if (waiting.length === 0) return "";
  const fees = feeCoinsSaid(waiting);
  const later = pricedLater(legs);
  return quote([fees, later].flatMap((line) => (line ? [literal(line)] : [])));
}

/** Whether every fact of the card fits in one message. */
export function fitsHere(legs: readonly ActionRow[]): boolean {
  return cardText(legs, true).length + tapNotes(legs).length <= CARD_CHARS;
}

/** A card's message. A grant is drawn only on an approval that fits here in full. */
export function drawCard(view: CardView, grant: string | null): ChannelMessage {
  const { legs } = view;
  const waiting = waitingOn(legs);
  const whole = fitsHere(legs);
  const held = legs.some((leg) => leg.phase === "needs_owner");
  const appOnly = waiting && (view.inTheApp || !whole);
  const task = held ? "check this move" : view.secret ? "enter the key" : "review this card";
  const destination =
    appOnly || held || !whole ? viaApp(view, held ? "Check status" : "Open in Auni", task) : null;
  const label = waiting && grant && !appOnly ? actionLabel(legs) : null;
  const decline = { label: "Decline", press: `decline:${grant}` };
  const approve = label ? { label, press: `allow:${grant}` } : null;
  const buttons: ChannelMessage["buttons"] =
    destination?.buttons ??
    (approve
      ? approve.label.length > 24
        ? [[approve], [decline]]
        : [[approve, decline]]
      : transactionButtons(legs));
  const note = appOnly
    ? view.secret
      ? "Never paste a key in this chat."
      : view.proof
        ? "Confirm it's you in Auni."
        : !whole
          ? "See the full card in Auni before you decide."
          : null
    : null;
  const where = decisionLine(legs, view.decidedIn);
  return {
    text: [
      view.threadName && `*${literal(view.threadName.slice(0, 160))}*`,
      cardText(legs, whole),
      whole && tapNotes(legs),
      note,
      where,
      !destination?.buttons && destination?.text,
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(buttons?.length && { buttons }),
  };
}

function decisionLine(legs: readonly ActionRow[], where: string | null): string | null {
  if (!where || legs.every(({ status }) => status === "replaced" || status === "retracted"))
    return null;
  const place = where === "here" ? where : `in ${literal(where)}`;
  return `${legs.every(({ status }) => status === "cancelled") ? "Declined" : "Allowed"} ${place}.`;
}

function transactionButtons(legs: readonly ActionRow[]): ChannelButton[][] | undefined {
  if (legs.length !== 1) return;
  const [leg] = legs;
  if (leg?.status !== "done") return;
  const tx = leg.txs.findLast(({ setup, buysFees }) => !setup && !buysFees);
  const explorer = tx?.hash && explorerTx(tx.chain, tx.hash);
  if (explorer) return [[{ label: "View transaction", url: explorer.url }]];
}

/** What a card's message shows, as a digest, whichever grant its buttons carry. */
export function shownKey(view: CardView, digest: string): string {
  const drawn = drawCard(view, waitingOn(view.legs) && !view.inTheApp ? SOME_GRANT : null);
  return (
    REVIEW_LAYOUT +
    createHash("sha256")
      .update(JSON.stringify([drawn, digest]))
      .digest("hex")
  );
}

function legStatus(leg: ActionRow, whole: boolean): string {
  const error = whole && leg.error ? ` ${literal(leg.error)}` : "";
  if (leg.run.settledBy === "owner") return "Closed." + error;
  switch (leg.status) {
    case "awaiting_permission":
      return "Waiting on you";
    case "running":
      if (leg.phase === "queued") return "Queued to send";
      if (leg.phase === "needs_owner") return `Status unknown.${error} Auni won't send this again.`;
      if (leg.phase === "unsure") return "Checking whether it went through";
      if (leg.phase === "landing")
        return leg.run.lands && whole
          ? `On its way: ${literal(leg.run.lands)}`
          : "Sent. Waiting for it to land.";
      return leg.txs.some((tx) => tx.hash && !tx.setup && !tx.buysFees)
        ? "Sent"
        : leg.card && whole
          ? literal(faceWords(leg, leg.card.working))
          : "Sending";
    case "done":
      if (isAsk(leg.tool)) return ASK_DONE[leg.tool];
      // A landing can time out as done, with the outcome in its note.
      if (leg.error) return whole ? literal(leg.error) : "Check the outcome in Auni";
      return leg.run.lands ? "Landed" : "Done";
    case "failed":
      return `Didn't go through.${error}`;
    case "cancelled":
      return "Declined";
    case "replaced":
      return "Replaced by a newer card";
    case "retracted":
      return whole && leg.error ? literal(leg.error) : "Taken back by Auni";
  }
}

function arrived(
  network: string,
  moved: readonly { amount: string; symbol: string; to: string | null }[],
): string {
  return quote([
    literal(network),
    ...moved.map(({ amount, symbol, to }) =>
      literal(`${amount} ${symbol}${to ? ` to ${to}` : ""}`),
    ),
  ]);
}

/** A sealed notice, or the wallet address for a deposit on the named network. */
export function drawNotice(
  card: CardWire,
  where: AppDestination,
  wallet?: WalletAddresses,
  expired = false,
): ChannelMessage {
  const title = `**${literal(card.title)}**`;
  switch (card.kind) {
    case "arrival":
      return { text: `${title}\n${arrived(card.network, card.moved)}` };
    case "venue_event":
      return { text: `${title}\n${quote([literal(card.detail)])}` };
    case "deposit": {
      if (card.landed) {
        const { usdValue, network, moved } = card.landed;
        const title = `**${dollars(usdValue)} arrived**`;
        const facts = arrived(network, moved);
        if (facts.length <= CARD_CHARS) return { text: `${title}\n${facts}` };
        const { text, buttons } = viaApp(where, "View deposit", "see the full deposit");
        return {
          text: [title, quote([literal(network)]), !buttons && text].filter(Boolean).join("\n\n"),
          ...(buttons && { buttons }),
        };
      }
      if (expired) return { text: `${title}\n\nThis card stopped watching for a deposit.` };
      const network = card.network && NETWORKS[card.network];
      const address = card.network === "solana" ? wallet?.solana : wallet?.evm;
      if (!network || !address) return drawLink(card.title, where.link, where.machine);
      const tokenAddresses = card.tokens.flatMap(({ name, address }) =>
        address
          ? [
              `${literal(name)} ${card.network === "solana" ? "mint" : "contract"}: \`${literal(address)}\``,
            ]
          : [],
      );
      return {
        text: [
          title,
          quote([`Send on ${literal(network.name)}`, ...tokenAddresses]),
          `**Your wallet address**\n\`${literal(address)}\``,
          "Watching for your deposit",
        ].join("\n\n"),
        buttons: [[{ label: `Copy ${network.name} wallet address`, copy: address }]],
      };
    }
    default:
      return drawLink(card.title, where.link, where.machine);
  }
}

/** A question with its answers as buttons, or with the answer the owner picked. */
export function drawQuestion(question: ChannelQuestion, answered?: string): ChannelMessage {
  if (answered !== undefined)
    return { text: `${question.text}\n\nYou answered: ${literal(answered)}` };
  return {
    text: question.text,
    buttons: question.options.map((label, index) => [{ label, press: `reply:${index}` }]),
  };
}

/** An answer as a channel sends it: its words, cards and question, in the order they came. */
type Segment =
  | ({ readonly kind: "text" } & ChannelMessage)
  | { readonly kind: "card"; readonly card: CardWire }
  | { readonly kind: "question"; readonly question: ChannelQuestion };

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly state?: string;
  readonly input?: unknown;
  readonly data?: { readonly text?: string; readonly cards?: readonly CardWire[] };
}

/**
 * An answer's parts as messages: its text between cards as one message each, every card core
 * sealed (only those reach a stored answer as data-cards), and each question it finished asking.
 */
export function replySegments(parts: readonly unknown[]): Segment[] {
  const segments: Segment[] = [];
  // Each text part is a block of its own, as the web app shows it.
  let blocks: string[] = [];
  let thoughts: string[] = [];
  const flush = () => {
    const text = blocks
      .map((block) => block.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text || thoughts.length)
      segments.push({
        kind: "text",
        text,
        ...(thoughts.length && { detail: ["**Thinking**", ...thoughts].join("\n\n") }),
      });
    blocks = [];
    thoughts = [];
  };
  for (const part of parts as Part[]) {
    if (part.type === "text" && typeof part.text === "string") blocks.push(part.text);
    else if (part.type === "data-reasoning" && typeof part.data?.text === "string") {
      if (part.data.text.trim()) thoughts.push(part.data.text.trim());
    } else if (part.type === "reasoning" && typeof part.text === "string") {
      if (part.text.trim()) thoughts.push(part.text.trim());
    } else if (part.type === "data-cards") {
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
