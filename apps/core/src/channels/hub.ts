import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { mainChat } from "../conversation/places.ts";
import { sendMessage } from "../conversation/send.ts";
import { threadById } from "../conversation/threads.ts";
import { db } from "../db/client.ts";
import {
  actions,
  channelDeliveries,
  channelLinks,
  messages,
  threads,
  type ChannelDeliveryRow,
  type ChannelLinkRow,
} from "../db/schema.ts";
import { keepRunning, untilSettingsChange } from "../jobs/keep-running.ts";
import { deliverKind } from "../jobs/kinds.ts";
import { defineJob, jobKind } from "../jobs/queue.ts";
import type { Channel, ChannelEvent } from "../apps/contract.ts";
import { channels, offered } from "../apps/registry.ts";
import { allowAction, allowProposal, declineAction, declineProposal } from "../money/decide.ts";
import { proposalFunding } from "../money/funding.ts";
import { needsStepUp } from "../money/step-up.ts";
import { dollars } from "../money/summaries.ts";
import { centsToUsd, parseUnits, signedUsdToCents, usdToCents } from "../money/usd.ts";
import { allFills, holdersOf, threadBooks } from "../money/books.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "../money/fill-key.ts";
import { portfolioNow } from "../money/portfolio.ts";
import { valueHistory } from "../money/value-history.ts";
import {
  appDestination,
  hashOf,
  legsDigest,
  legsOf,
  recordSent,
  sendCard,
  pendingCard,
  spendGrant,
  syncCards,
  syncDelivery,
} from "./cards.ts";
import { drawQuestion, literal, replySegments, showsFullReview, waitingOn } from "./draw.ts";
import { usedChannel } from "./home.ts";
import { showTurn, takeTurnStatus } from "./progress.ts";

// The owner talks to Auni from channel apps (Telegram) as well as the web app, in one shared
// conversation. The hub is where a channel's words become the owner's, and so it alone decides:
//
//   a channel event --> from the paired owner, in their direct chat?  no --> ignored
//        |                                                            (a code pairs a new one)
//        | a message: joins the thread of the message it replies to, else their main chat
//        | a press:   a question's answer, or Allow/Decline with the grant drawn on that card,
//        |            which goes through money/decide.ts, the web app's own path
//        | a hello:   the app's own start or help (Telegram's /start), answered here, never
//        |            by the agent
//        v
//   a turn queues its answer (deliverJob): to the chat the owner wrote from, or for a turn they
//   didn't ask for, to their home channel (channels/home.ts)

const PAIRING_TTL_MS = 15 * 60_000;
const SYNC_EVERY_MS = 3_000;

interface Found {
  readonly id: string;
  readonly name: string;
  readonly channel: Channel;
}

function channelById(id: string): Found | undefined {
  const found = channels(offered()).find(({ about }) => about.id === id);
  return found && { id, name: found.about.name, channel: found.channel };
}

// The card messages are redrawn one at a time, by presses and by the sync alike, so a press's
// fresh grant and the sync's can never land on one message out of order.
let tail: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}

/**
 * Listens on every channel that is set up, and keeps their cards in step, until the runner aborts
 * it (a sleep or a stop), when its cron starts it again, or a setting is saved, when it starts
 * again at once: a channel reads its token as it starts listening. The runner's lock means one
 * Auni listens, which a long poll needs: two polling one bot split its messages between them.
 */
export const channelsJob = defineJob({
  kind: jobKind("channels", z.object({})),
  every: 10_000,
  endsOnSleep: true,
  run: (_data, { signal }) => untilSettingsChange(signal, listenOnChannels),
});

/** What channelsJob runs; tests call it directly. */
export async function listenOnChannels(signal: AbortSignal): Promise<void> {
  const ready = channels(offered()).filter(({ channel }) => channel.configured());
  if (ready.length === 0) return;
  await Promise.all([
    ...ready.map(({ about, channel }) => {
      console.log(`Auni listens on ${about.name}.`);
      return keepRunning(
        `listening on ${about.name}`,
        (stop) => channel.listen((event) => receive(about.id, event), stop),
        signal,
      );
    }),
    // An owned loop, not a cron: a sync every 3 seconds would write a jobs row as often, and it
    // must share oneAtATime with presses, which only a loop in this process can.
    keepCardsInStep(signal),
  ]);
}

/**
 * Syncs the cards a while after each sync ends, never on a clock: a sync stuck on a slow Bot API
 * call then delays the next, rather than queueing more in front of every press.
 */
async function keepCardsInStep(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sleep(SYNC_EVERY_MS, undefined, { signal }).catch(() => undefined);
    if (signal.aborted) return;
    await oneAtATime(syncCards).catch((error: unknown) =>
      console.error("channel cards couldn't be synced", error),
    );
  }
}

/**
 * A fresh one-time code that pairs whoever sends it to this channel, in a direct chat, as the
 * owner there, and how they send it; null for a channel that isn't set up.
 */
export async function mintChannelPairing(
  channelId: string,
): Promise<{ readonly code: string; readonly hint: string } | null> {
  const found = channelById(channelId);
  if (!found?.channel.configured()) return null;
  const code = randomBytes(24).toString("base64url");
  const pending = {
    pairingHash: hashOf(code),
    pairingExpiresAt: new Date(Date.now() + PAIRING_TTL_MS),
  };
  await db
    .insert(channelLinks)
    .values({ channel: channelId, ...pending })
    .onConflictDoUpdate({ target: channelLinks.channel, set: pending });
  return { code, hint: await found.channel.pairingHint(code) };
}

async function linkOf(channelId: string): Promise<ChannelLinkRow | undefined> {
  const [link] = await db.select().from(channelLinks).where(eq(channelLinks.channel, channelId));
  return link;
}

/** Whether an event came from the paired owner, in their direct chat with Auni. */
function fromOwner(
  link: ChannelLinkRow | undefined,
  event: Pick<ChannelEvent, "chat" | "direct" | "from">,
): boolean {
  return Boolean(
    link?.owner && event.direct && event.from === link.owner && event.chat === link.chat,
  );
}

/**
 * Everything a channel hands the hub. What it returns answers a press, shown to the presser.
 * Nothing from anyone but the owner, or from any chat but theirs with Auni, does anything.
 */
export async function receive(channelId: string, event: ChannelEvent): Promise<string | void> {
  const found = channelById(channelId);
  if (!found) return;
  const link = await linkOf(channelId);
  if (event.kind === "press") {
    if (!fromOwner(link, event))
      return "Only Auni's owner can tap this, in their direct chat with Auni.";
    await usedChannel(db, channelId);
    return pressed(found, event);
  }
  // A code first, even from the owner pairing again, so a code is never said to the agent: the
  // one a link opened the chat with, or one typed.
  const code = event.kind === "hello" ? event.code : event.text.trim();
  if (event.direct && code && link?.pairingHash && (await pair(channelId, event, code))) {
    await usedChannel(db, channelId);
    await found.channel.send(event.chat, { text: PAIRED });
    return;
  }
  if (!fromOwner(link, event)) return;
  if (event.kind === "message") return ownerSaid(found, event);
  // The app's own start or help, answered here: it was never words for the agent.
  await usedChannel(db, channelId);
  if (event.command === "pending") return pending(found, event.chat);
  if (event.command === "money") return money(found, event.chat);
  await found.channel.send(event.chat, { text: STILL_PAIRED });
}

const PAIRED =
  "**You're paired with Auni.**\n\nTell me a take, like “AI power demand keeps climbing.” Use /pending to see cards waiting on you.";
const STILL_PAIRED =
  "**Talk to Auni here**\n\nSend a take, or reply to any message to continue that chat.\n\n/pending lists cards waiting on you. /money shows your cash and takes.";

async function pending(found: Found, chat: string): Promise<void> {
  const rows = await db
    .select()
    .from(actions)
    .where(or(eq(actions.status, "awaiting_permission"), eq(actions.phase, "needs_owner")))
    .orderBy(actions.createdAt, actions.id);
  let ready = 0;
  for (const group of Map.groupBy(rows, (row) => row.proposalId ?? row.id).values()) {
    const row = group.find(({ phase }) => phase === "needs_owner") ?? group[0]!;
    const send = await pendingCard(found, chat, row);
    if (!send) continue;
    ready += 1;
    if (ready <= 4) await send();
  }
  if (ready > 4) {
    const { link, machine } = appDestination("/app");
    const more = ready - 4;
    await found.channel.send(chat, {
      text: link
        ? `${more} more waiting in Auni`
        : `${more} more waiting. Open Auni on ${literal(machine)} to see them.`,
      ...(link && { buttons: [[{ label: "Open Money", url: link }]] }),
    });
  }
  if (ready === 0)
    await found.channel.send(chat, {
      text: rows.length
        ? "No cards are ready to review yet."
        : "You're caught up. No cards are waiting on you.",
    });
}

async function money(found: Found, chat: string): Promise<void> {
  const link = appDestination("/app").link;
  const buttons = link ? [[{ label: "Open Money", url: link }]] : undefined;
  const summary = await readMoney().catch(
    () => "I couldn't read your balances just now. Try /money again.",
  );
  await found.channel.send(chat, { text: `**Money**\n\n${summary}`, buttons });
}

function moneyChange(points: Awaited<ReturnType<typeof valueHistory>>["points"]): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || first === last) return "";
  const change = signedUsdToCents(last.madeUsd) - signedUsdToCents(first.madeUsd);
  const amount = dollars(centsToUsd(change < 0n ? -change : change));
  const sign = change < 0n ? "-" : change > 0n ? "+" : "";
  return ` (${sign}${amount} today)`;
}

async function readMoney(): Promise<string> {
  const [portfolio, fills] = await Promise.all([portfolioNow(), allFills(db)]);
  const books = threadBooks(fills);
  const ids = [...books.keys()];
  const [takes, history] = await Promise.all([
    ids.length
      ? db
          .select({ id: threads.id, title: threads.title })
          .from(threads)
          .where(inArray(threads.id, ids))
          .orderBy(threads.title, threads.id)
      : [],
    valueHistory("Today").catch(() => null),
  ]);
  const values = new Map<string, { cents: bigint; priced: boolean }>();
  let looseHoldings = false;
  let loosePriced = false;
  // Allocate each holding once, even if several takes bought more than the wallet now holds.
  for (const holding of portfolio.assets.holdings) {
    const units = parseUnits(holding.quantity, QUANTITY_DECIMALS);
    if (units === 0n) continue;
    const { threads: owners, other: loose } = holdersOf(
      holding.short ? -units : units,
      books,
      fillIdentity(holding),
    );
    if (loose > 0n) {
      looseHoldings = true;
      if (holding.usdValue !== null) loosePriced = true;
    }
    for (const [id, share] of owners) {
      const value = values.get(id) ?? { cents: 0n, priced: false };
      if (holding.usdValue !== null) {
        value.cents += (usdToCents(holding.usdValue) * share) / units;
        value.priced = true;
      }
      values.set(id, value);
    }
  }
  // Unassigned holdings and cents left from splitting a holding belong on their own line.
  let other = usdToCents(portfolio.assets.usdValue);
  const lines = takes.flatMap(({ id, title }) => {
    const value = values.get(id);
    if (!value) return [];
    other -= value.cents;
    const amount = value.priced ? dollars(centsToUsd(value.cents)) : "Value unavailable";
    return [`> ${literal(title || "Untitled take")}: ${amount}`];
  });
  const missing = [...new Set([...portfolio.unavailable, ...portfolio.looking])];
  return [
    `> Total: ${dollars(portfolio.totalUsd)}${moneyChange(history?.points ?? [])}`,
    `> Cash: ${dollars(portfolio.cash.usdValue)}`,
    ...lines,
    ...(other || looseHoldings
      ? [
          `> Other holdings: ${other || loosePriced ? dollars(centsToUsd(other)) : "Value unavailable"}`,
        ]
      : []),
    ...(portfolio.onTheWay.moves.length
      ? [`> On the way: ${dollars(portfolio.onTheWay.usdValue)}`]
      : []),
    ...(missing.length ? [`\nStill missing balances from ${literal(missing.join(", "))}.`] : []),
  ].join("\n");
}

/** Spends a pairing code sent in a direct chat, making its sender the owner here. */
async function pair(
  channelId: string,
  sender: Pick<ChannelEvent, "from" | "chat">,
  code: string,
): Promise<boolean> {
  const [paired] = await db
    .update(channelLinks)
    .set({
      owner: sender.from,
      chat: sender.chat,
      pairedAt: sql`now()`,
      pairingHash: null,
      pairingExpiresAt: null,
    })
    .where(
      and(
        eq(channelLinks.channel, channelId),
        eq(channelLinks.pairingHash, hashOf(code)),
        gt(channelLinks.pairingExpiresAt, sql`now()`),
      ),
    )
    .returning({ channel: channelLinks.channel });
  return Boolean(paired);
}

/** A message id from a channel's own, so a redelivered message is stored once. */
function messageIdFrom(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  // Shaped as a name-based UUID (version 5, RFC variant), which any UUID check accepts.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The owner's message joins the thread of the message it replies to, or else their main chat,
 * where the daily brief and news land too: one memory, whichever app they write from.
 */
async function ownerSaid(found: Found, event: ChannelEvent & { kind: "message" }): Promise<void> {
  const repliedTo = event.replyTo ? await deliveryAt(found.id, event.replyTo) : undefined;
  const thread =
    (repliedTo && (await threadById(repliedTo.threadId))) ??
    (await threadById((await mainChat(db)).id));
  if (!thread) throw new Error("The owner's main chat is gone.");
  const turnId = messageIdFrom(`${found.id}:${event.id}`);
  const sent = await sendMessage(thread, {
    id: turnId,
    text: event.text,
    channel: found.id,
    channelRef: event.id,
  });
  if (sent === "sent") {
    void found.channel.acknowledge?.(event.id).catch(() => undefined);
    showAnswerProgress(found, event, thread.id, turnId, event.id);
  }
}

function showAnswerProgress(
  found: Found,
  event: Pick<ChannelEvent, "chat" | "direct" | "from">,
  threadId: string,
  turnId: string,
  replyTo: string,
): void {
  showTurn({
    channelId: found.id,
    channel: found.channel,
    chat: event.chat,
    replyTo,
    threadId,
    turnId,
    stillPaired: async () => fromOwner(await linkOf(found.id), event),
  });
}

async function deliveryAt(channelId: string, ref: string): Promise<ChannelDeliveryRow | undefined> {
  const [delivery] = await db
    .select()
    .from(channelDeliveries)
    .where(and(eq(channelDeliveries.channel, channelId), eq(channelDeliveries.ref, ref)));
  return delivery;
}

/** A press from the owner: an answer to a question, or a decision on a card. */
async function pressed(found: Found, event: ChannelEvent & { kind: "press" }): Promise<string> {
  const [verb, token = ""] = event.data.split(/:(.*)/su);
  if (verb === "reply") return answered(found, event, Number(token));
  if (verb === "allow" || verb === "decline")
    return oneAtATime(() => decide(found, event, verb, token));
  return "That button isn't active.";
}

async function answered(
  found: Found,
  event: ChannelEvent & { kind: "press" },
  index: number,
): Promise<string> {
  if (!Number.isInteger(index) || index < 0) return "That button isn't active.";
  // Closed as it is answered, so a second press sends nothing more.
  const [delivery] = await db
    .update(channelDeliveries)
    .set({ open: false })
    .where(
      and(
        eq(channelDeliveries.channel, found.id),
        eq(channelDeliveries.ref, event.message),
        eq(channelDeliveries.open, true),
        isNotNull(channelDeliveries.question),
      ),
    )
    .returning();
  const label = delivery?.question?.options[index];
  if (!delivery?.question || label === undefined) return "Already answered.";
  const thread = await threadById(delivery.threadId);
  if (!thread) return "That chat is gone.";
  const turnId = messageIdFrom(`${found.id}:answer:${delivery.id}`);
  const sent = await sendMessage(thread, {
    id: turnId,
    text: label,
    channel: found.id,
    channelRef: event.message,
  });
  event.answer?.("Sent.");
  await found.channel.edit(delivery.ref, drawQuestion(delivery.question, label));
  if (sent === "sent") showAnswerProgress(found, event, thread.id, turnId, event.message);
  return "Sent.";
}

/**
 * Allow or Decline on a card: only with the grant drawn on this very message, unspent, within its
 * day, for the card as it still is, and then through the web app's own path (money/decide.ts),
 * which takes no proof from a channel for a card that needs the owner's. The card is redrawn either way.
 */
async function decide(
  found: Found,
  event: ChannelEvent & { kind: "press" },
  verb: "allow" | "decline",
  grant: string,
): Promise<string> {
  const delivery = await spendGrant(found.id, event.message, grant);
  if (!delivery) return "This button expired. Nothing moved. Open Auni to decide this card.";
  const target = delivery.actionId
    ? { actionId: delivery.actionId }
    : delivery.proposalId
      ? { proposalId: delivery.proposalId }
      : null;
  const legs = target ? await legsOf(target) : [];
  let answer: string;
  if (!target || legs.length === 0) answer = "That card is gone. Nothing moved.";
  else if (legsDigest(legs) !== delivery.cardDigest)
    answer = "This card changed, so nothing moved. Review the updated card first.";
  else if (!waitingOn(legs)) answer = "Already decided.";
  else if (!showsFullReview(delivery.shown)) answer = "Review the updated card first.";
  else {
    const decided = verb === "allow" ? await allowed(target, legs) : await declined(target);
    if (decided.won)
      await db
        .update(channelDeliveries)
        .set({ decidedAt: sql`now()` })
        .where(eq(channelDeliveries.id, delivery.id));
    answer = decided.answer;
  }
  event.answer?.(answer);
  const [now] = await db
    .select()
    .from(channelDeliveries)
    .where(eq(channelDeliveries.id, delivery.id));
  if (now) await syncDelivery(now);
  return answer;
}

type Decided = { readonly won: boolean; readonly answer: string };
const NOT_WAITING: Decided = { won: false, answer: "Already decided." };
const TAKES_PROOF: Decided = {
  won: false,
  answer: "Confirm it's you in Auni to allow this.",
};

async function allowed(
  target: { readonly actionId: string } | { readonly proposalId: string },
  legs: Awaited<ReturnType<typeof legsOf>>,
): Promise<Decided> {
  if ("actionId" in target) {
    // A channel's tap proves nothing of who is at the computer, so a card that takes that is refused.
    const outcome = await allowAction(target.actionId);
    if (outcome.kind === "refused") return TAKES_PROOF;
    if (outcome.kind === "not_waiting") return NOT_WAITING;
    if (outcome.kind === "in_its_field")
      return { won: false, answer: "Enter this in Auni's private field, never in chat." };
    return { won: true, answer: "Allowed." };
  }
  const waiting = legs.filter((leg) => leg.status === "awaiting_permission");
  if ((await Promise.all(waiting.map((leg) => needsStepUp(leg)))).some(Boolean)) return TAKES_PROOF;
  // As the web app's card does, a plan short of cash asks for it before it runs.
  const funding = await proposalFunding(legs);
  if (funding)
    return {
      won: false,
      answer: `Add ${dollars(funding.needUsd)} to your wallet first, then try again.`,
    };
  const rows = await allowProposal(target.proposalId);
  return rows.length > 0 ? { won: true, answer: "Allowed." } : NOT_WAITING;
}

async function declined(
  target: { readonly actionId: string } | { readonly proposalId: string },
): Promise<Decided> {
  const won =
    "actionId" in target
      ? (await declineAction(target.actionId)) !== null
      : (await declineProposal(target.proposalId)).length > 0;
  return won ? { won: true, answer: "Declined." } : NOT_WAITING;
}

/**
 * Sends a turn's answer on a channel, queued with it (conversation/turn.ts): its words, each card
 * (drawn from the records, with buttons only the hub puts there) and its question. A turn that
 * failed with nothing to show says so. Never run twice: a run cut off midway may have sent part.
 */
export const deliverJob = defineJob({
  kind: deliverKind,
  run: (data) => deliver(data),
  cutShort: async ({ messageId }) => {
    console.error(`answer ${messageId ?? "(failed turn)"} was cut off on its way to its channel`);
  },
});

/** What deliverJob runs; tests call it directly. */
export async function deliver(input: {
  readonly channel: string;
  readonly threadId: string;
  /** The answer as stored; unset, a turn that failed before it had one. */
  readonly messageId?: string;
  readonly replyTo?: string;
}): Promise<void> {
  const found = channelById(input.channel);
  const link = found && (await linkOf(found.id));
  // Unpaired, or its token taken away since: the web app shows the answer alone.
  if (!found?.channel.configured() || !link?.chat) return;
  const [answer] = input.messageId
    ? await db
        .select({ parts: messages.parts, metadata: messages.metadata })
        .from(messages)
        .where(and(eq(messages.id, input.messageId), eq(messages.threadId, input.threadId)))
    : [];
  // Its chat was deleted before it went out: there is nothing left to send.
  if (input.messageId && !answer) return;
  const segments = replySegments(answer?.parts ?? []);
  if (
    !segments.some((segment) => segment.kind !== "text" || segment.text) &&
    (!answer || answer.metadata.failed)
  )
    segments.push({ kind: "text", text: "I couldn't finish that reply. Try asking again." });
  const status = await takeTurnStatus(found.id, link.chat, input.replyTo);
  for (const [index, segment] of segments.entries()) {
    const replace = index === 0 ? status : undefined;
    if (segment.kind === "text")
      await recordSent(
        found,
        input.threadId,
        await found.channel.send(link.chat, segment, input.replyTo, replace),
        {},
      );
    else if (segment.kind === "card")
      await sendCard(
        found,
        link.chat,
        input.threadId,
        segment.card,
        input.messageId,
        input.replyTo,
        replace,
      );
    else
      await recordSent(
        found,
        input.threadId,
        await found.channel.send(
          link.chat,
          { ...drawQuestion(segment.question), detail: segment.detail },
          input.replyTo,
          replace,
        ),
        { question: segment.question, open: true },
      );
  }
}
