import { createHash } from "node:crypto";

import {
  AMOUNT,
  ASK_DONE,
  HELD,
  LETS_LINE,
  RETRACTED,
  SUMMARY_VERBS,
  filledUsd,
  NETWORKS,
  isAsk,
  storedSuggestRepliesSchema,
  type CardWire,
} from "@auni/shared";

import type { ActionRow, ChannelQuestion } from "../db/schema.ts";
import type { ChannelButton, ChannelMessage, WalletAddresses } from "../apps/contract.ts";
import { lossWarning, planAction, pricedLater } from "../money/action-card.ts";
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
export function drawLink(
  title: string,
  link: string | null,
  machine?: string,
  task = "view this",
): ChannelMessage {
  const { text, buttons } = viaApp({ link, machine }, "Open in Auni", task);
  return {
    text: `**${literal(title)}**\n\n${link ? "" : text}`.trimEnd(),
    ...(buttons && { buttons }),
  };
}

/** A card as one message shows it. */
export interface CardView extends AppDestination {
  readonly legs: readonly ActionRow[];
  readonly statusLink?: string | null;
  /** It takes proof, needs a private field, or is too long to review here in full. */
  readonly inTheApp: boolean;
  readonly outOfDate?: boolean;
  readonly proof?: boolean;
  readonly secret?: boolean;
  readonly decidedIn: string | null;
  readonly threadName?: string | null;
}

export const waitingOn = (legs: readonly Pick<ActionRow, "status">[]): boolean =>
  legs.some((leg) => leg.status === "awaiting_permission");

/** The buttons' grant stands in by this while working out whether a message changed. */
const SOME_GRANT = "grant";
const REVIEW_LAYOUT = "review-v4:";

/** Earlier messages could omit terms in the current review. */
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
  const amount = money?.endsWith(" in") ? `${money.slice(0, -3)} total` : money;
  return `${legs.length} moves${amount ? `, ${amount}` : ""}`;
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
  const spend = money.some((amount) => amount?.flow === "in" && Number(amount.usd) > 0);
  return singleLine(
    label.includes(AMOUNT)
      ? label.replaceAll(AMOUNT, total)
      : spend
        ? `${label} (${total})`
        : label,
  );
}

/** Very long asset names stay in the card's title, where they can wrap. */
function compactApproval(label: string): string {
  if (label.length <= 28) return label;
  const amount = /\$[\d,.]+/u.exec(label);
  if (!amount) return "Allow this card";
  const throughAmount = label.slice(0, amount.index + amount[0].length);
  if (throughAmount.length <= 28 && !throughAmount.includes("(")) return throughAmount;
  return `Allow ${amount[0]}`;
}

function reviewLines(leg: ActionRow, showLets: boolean): string[] {
  const { card } = leg;
  const lines = leg.lines
    .filter(({ label }) => showLets || label !== LETS_LINE)
    .map(({ label, value }) => `${literal(label)}: ${literal(value)}`);
  const warning = lossWarning(leg, card?.warning);
  if (!card) return warning ? [...lines, literal(warning)] : lines;
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
      ...[card.finePrint, warning, card.checks?.why].flatMap((line) =>
        line ? [literal(line)] : [],
      ),
    ]),
  ];
}

function receipt(leg: ActionRow): string | null {
  if (leg.status !== "done" || leg.error || isAsk(leg.tool) || leg.run.settledBy === "owner")
    return null;
  if (leg.run.filled) return leg.run.filled;
  const face = leg.card?.receipt;
  const actual = filledUsd(leg.run);
  if (!face || !actual) return null;
  return [face.title, `${dollars(actual)}${face.amount === "back" ? " back" : ""}`, face.detail]
    .filter(Boolean)
    .join("\n");
}

const RECEIPT_VERBS = new Set(Object.values(SUMMARY_VERBS).map(({ past }) => past.toLowerCase()));

/** A short outcome that can follow a number without losing what happened. */
function planOutcome(leg: ActionRow): string {
  if (leg.run.settledBy === "owner") return "closed";
  switch (leg.status) {
    case "awaiting_permission":
      return "waiting on you";
    case "running":
      if (leg.phase === "needs_owner") return "with status unknown";
      if (leg.phase === "landing") return "on the way";
      if (leg.phase === "unsure") return "being checked";
      return leg.phase === "queued" ? "queued to send" : "sending";
    case "done": {
      if (leg.error) return "sent, awaiting confirmation";
      if (leg.run.lands) return "landed";
      const verb = receipt(leg)?.split(/\s+/u)[0]?.toLowerCase() ?? "";
      return RECEIPT_VERBS.has(verb) ? verb : "completed";
    }
    case "failed":
      return "didn't go through";
    case "cancelled":
      return "declined";
    case "replaced":
      return "replaced";
    case "retracted":
      return "taken back";
  }
}

function planProgress(legs: readonly ActionRow[]): string {
  return [...Map.groupBy(legs, planOutcome)]
    .map(([outcome, group]) =>
      outcome === "waiting on you" || outcome === "with status unknown"
        ? `${group.length} ${group.length === 1 ? "move" : "moves"} ${outcome}`
        : `${group.length} ${outcome}`,
    )
    .join(", ");
}

function compactPlanState(leg: ActionRow): string {
  if (leg.phase === "needs_owner" && leg.run.held !== "unrecorded")
    return "Status unknown. Money may have moved. Auni won't send it again.";
  if (
    leg.status === "failed" ||
    (leg.status === "done" && leg.error) ||
    leg.phase === "unsure" ||
    leg.phase === "needs_owner" ||
    leg.run.settledBy === "owner"
  )
    return legStatus(leg, false);
  return "";
}

function takenOff(legs: readonly ActionRow[]): boolean {
  return legs.every(({ status }) => status === "retracted" || status === "replaced");
}

function sharedEnd(legs: readonly ActionRow[]): string | null {
  if (!takenOff(legs)) return null;
  const [first, ...rest] = legs.map((leg) => legStatus(leg, true));
  return first !== undefined && rest.every((status) => status === first) ? first : null;
}

function cardText(legs: readonly ActionRow[], whole: boolean): string {
  const one = legs.length === 1;
  const compactPlan = !one && !whole;
  const end = !one ? sharedEnd(legs) : null;
  const settledPlan =
    !one && legs.every(({ status }) => status !== "awaiting_permission" && status !== "running");
  const notes = whole ? tapNotes(legs) : "";
  const waitingPlan = !one && legs.some(({ status }) => status === "awaiting_permission");
  const compactStates = compactPlan ? legs.map(compactPlanState) : [];
  // Leave room for money outcomes before sharing the rest between the move names.
  const limit = compactPlan
    ? Math.max(40, Math.floor((2_000 - compactStates.join("\n").length) / legs.length))
    : 250;
  const text = legs.map((leg, index) => {
    const filled = whole ? receipt(leg) : null;
    const [title, ...detail] = filled?.split("\n") ?? [];
    const heading = title ?? (leg.card ? faceWords(leg, leg.card.title) : leg.summary);
    const prefix = one ? "" : `${index + 1}. `;
    const facts =
      whole && !end
        ? filled && leg.run.filled
          ? detail.map(literal)
          : [
              ...detail.map(literal),
              ...reviewLines(leg, one || leg.status === "awaiting_permission"),
            ]
        : [];
    const showState =
      !filled &&
      !end &&
      (!waitingPlan || leg.status !== "awaiting_permission") &&
      (!settledPlan || leg.status === "failed" || leg.status === "retracted" || leg.error);
    const name = literal(heading);
    const shortName = name.slice(0, limit - 1).replace(/\\+$/u, "") + "…";
    return [
      `**${prefix}${whole || name.length <= limit ? name : shortName}**`,
      quote(facts),
      one && notes,
      compactPlan ? compactStates[index] : showState && legStatus(leg, whole),
    ]
      .filter(Boolean)
      .join("\n");
  });
  if (one) return text[0]!;
  const title = `**${literal(planName(legs))}**`;
  if (compactPlan && end) return [title, end].join("\n");
  const progress = !end && (compactPlan || settledPlan || waitingPlan) && planProgress(legs);
  const body = [title, end, ...text, notes, progress]
    .filter(Boolean)
    .join(compactPlan ? "\n" : "\n\n");
  // Even the numbered summaries can overflow when a plan has many legs.
  return compactPlan && body.length > CARD_CHARS
    ? [title, progress].filter(Boolean).join("\n")
    : body;
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
  return cardText(legs, true).length <= CARD_CHARS;
}

/** A card's message. A grant is drawn only on an approval that fits here in full. */
export function drawCard(view: CardView, grant: string | null): ChannelMessage {
  const { legs } = view;
  const waiting = waitingOn(legs);
  if (view.outOfDate) {
    const name = legs.length === 1 ? legs[0]!.summary.slice(0, 250) : planName(legs);
    return { text: `**${literal(name)}**\n${RETRACTED.outOfDate}` };
  }
  const whole = fitsHere(legs);
  const held = legs.some((leg) => leg.phase === "needs_owner");
  const appOnly = waiting && (view.inTheApp || !whole);
  const task = held
    ? "check status"
    : view.secret
      ? "enter it in a private field"
      : !whole
        ? waiting
          ? "review the full card"
          : "see the full card"
        : "review this card";
  const destination = held
    ? viaApp({ ...view, link: view.statusLink ?? view.link }, "Check status", task)
    : appOnly || (!whole && !takenOff(legs))
      ? viaApp(view, "Open in Auni", task)
      : null;
  const label = waiting && grant && !appOnly ? actionLabel(legs) : null;
  const decline = { label: "Decline", press: `decline:${grant}` };
  const approve = label ? { label: compactApproval(label), press: `allow:${grant}` } : null;
  const buttons: ChannelMessage["buttons"] =
    destination?.buttons ??
    (approve && label
      ? label.length > 14
        ? [[approve], [decline]]
        : [[approve, decline]]
      : transactionButtons(legs));
  const note = appOnly
    ? view.secret
      ? "Saved only on this computer. Never paste it in chat."
      : view.proof
        ? "Confirm it's you first."
        : !whole
          ? "This card is too long to show in full here."
          : null
    : !whole && legs.length > 1 && !takenOff(legs)
      ? "This plan is too long to show in full here. Auni shows each move."
      : null;
  const where = decisionLine(legs, view.decidedIn);
  return {
    text: [
      view.threadName && `*${literal(view.threadName.slice(0, 160))}*`,
      cardText(legs, whole),
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
  if (!where || takenOff(legs)) return null;
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
  const drawn = drawCard(
    view,
    waitingOn(view.legs) && !view.inTheApp && !view.outOfDate ? SOME_GRANT : null,
  );
  return (
    REVIEW_LAYOUT +
    createHash("sha256")
      .update(JSON.stringify([drawn, digest]))
      .digest("hex")
  );
}

function legStatus(leg: ActionRow, whole: boolean): string {
  const error = whole && leg.error ? ` ${literal(leg.error)}` : "";
  if (leg.run.settledBy === "owner") {
    const why = leg.run.held ? HELD[leg.run.held] : "Auni couldn't confirm whether money moved.";
    return `Closed.${error || ` ${why}`}`;
  }
  switch (leg.status) {
    case "awaiting_permission":
      return "Waiting on you";
    case "running":
      if (leg.phase === "queued") return "Queued to send";
      if (leg.phase === "needs_owner")
        return `${heldStatus(leg)} Your Money page shows what you hold.`;
      if (leg.phase === "unsure")
        return "Checking whether it went through. Auni can't yet tell whether money moved.";
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
      if (leg.error)
        return `${whole ? literal(leg.error) : "Check the outcome in Auni."} Money was sent, but its arrival wasn't confirmed.`;
      return leg.run.lands && whole
        ? `Landed: ${literal(leg.run.lands)}`
        : leg.run.lands
          ? "Landed"
          : "Done";
    case "failed":
      if (leg.failureKind === "unshown" && leg.error) return literal(leg.error);
      return `Didn't go through.${error} ${failedOutcome(leg)}`;
    case "cancelled":
      return "Declined";
    case "replaced":
      return "Replaced by a newer card";
    case "retracted":
      return leg.error ? literal(leg.error) : "Taken back by Auni";
  }
}

function heldStatus(leg: ActionRow): string {
  switch (leg.run.held) {
    case "unrecorded":
      return "Money moved, but Auni couldn't confirm what came back and won't send it again.";
    case "overdue":
      return "Status unknown. Still unconfirmed after a day, so Auni won't send it again.";
    case "unanswered":
      return "Status unknown. Auni sent this and never heard back, so it won't send it again.";
    default:
      return "Status unknown. Auni can't confirm whether money moved and won't send it again.";
  }
}

/** A status notice for a held move without a sealed card to re-send. */
export function drawHeldNotice(leg: ActionRow, where: AppDestination): ChannelMessage {
  const { text, buttons } = viaApp(where, "Open Money", "see what you hold");
  const next = buttons ? "Your Money page shows what you hold." : text;
  return {
    text: `${literal(leg.summary)}\n\n${heldStatus(leg)} ${next}`,
    ...(buttons && { buttons }),
  };
}

function failedOutcome(leg: ActionRow): string {
  if (isAsk(leg.tool)) return "No money moved.";
  if (leg.failureKind === "sent" || leg.txs.some((tx) => tx.hash))
    return "Money may have moved or a fee may have been charged. Check in Auni.";
  if (leg.failureKind == null && leg.startedAt) return "Auni can't confirm whether money moved.";
  return "Nothing left your wallet.";
}

function arrived(
  network: string,
  moved: readonly { amount: string; symbol: string; to: string | null; network?: string }[],
): string {
  return quote([
    literal(network),
    ...moved.map(({ amount, symbol, to, network }) =>
      literal(`${amount} ${symbol}${network ? ` on ${network}` : ""}${to ? ` to ${to}` : ""}`),
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
      if (expired)
        return {
          text: `${title}\n\nStopped watching for this deposit. Anything you send to your wallet still arrives normally.`,
        };
      const networks = Object.values(NETWORKS);
      const cards = card.network ? [NETWORKS[card.network]].filter(Boolean) : networks;
      const addresses = [...Map.groupBy(cards, ({ key }) => key === "solana").entries()].flatMap(
        ([solana, supported]) => {
          const address = solana ? wallet?.solana : wallet?.evm;
          if (!address) return [];
          const names = supported.map(({ name }) => name);
          const label =
            names.length === 1 ? `Copy ${names[0]} wallet address` : "Copy shared wallet address";
          return [{ names, address, label }];
        },
      );
      if (!addresses.length) return drawLink(card.title, where.link, where.machine);
      return {
        text: [
          title,
          ...addresses.map(
            ({ names, address }) =>
              `**Your wallet address**\n\`${literal(address)}\`\n${quote([`Use on ${literal(names.join(", "))}`])}`,
          ),
          "Watching for your deposit",
        ].join("\n\n"),
        buttons: addresses.map(({ address, label }) => [{ label, copy: address }]),
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
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "card"; readonly card: CardWire }
  | { readonly kind: "question"; readonly question: ChannelQuestion };

type ReplySegment = Segment & { readonly detail?: string };

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
export function replySegments(parts: readonly unknown[]): ReplySegment[] {
  const segments: ReplySegment[] = [];
  // Each text part is a block of its own, as the web app shows it.
  let blocks: string[] = [];
  const thoughts: string[] = [];
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
  const firstText = segments.findIndex(({ kind }) => kind === "text");
  const index =
    firstText === -1 ? segments.findIndex(({ kind }) => kind === "question") : firstText;
  const answer = segments[index];
  if (answer && thoughts.length)
    segments[index] = { ...answer, detail: ["**Thinking**", ...thoughts].join("\n\n") };
  return segments;
}
