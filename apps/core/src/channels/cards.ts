import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { DEPOSIT_WAIT_MS, type CardWire, type DepositCardWire } from "@auni/shared";
import { and, asc, desc, eq, gt, isNotNull, or, sql } from "drizzle-orm";

import { db } from "../db/client.ts";
import { threadById } from "../conversation/threads.ts";
import {
  actions,
  channelDeliveries,
  messages,
  type ActionRow,
  type ChannelDeliveryRow,
} from "../db/schema.ts";
import { env } from "../env.ts";
import type { Channel } from "../apps/contract.ts";
import { channels, offered } from "../apps/registry.ts";
import { SETTLED } from "../money/life.ts";
import { needsStepUp } from "../money/step-up.ts";
import { walletAddresses } from "../money/wallets.ts";
import {
  drawCard,
  drawHeldNotice,
  drawNotice,
  fitsHere,
  replySegments,
  shownKey,
  waitingOn,
  type CardView,
} from "./draw.ts";

// Each card the hub sends is one message it keeps in step with the card's moves: it shows
// Allow and Decline while they wait, then running, sent and landed, and where they were decided.
// A card waiting for a tap carries a grant on its buttons (see channelDeliveries in schema.ts).

const GRANT_TTL_MS = 24 * 60 * 60_000;
const DEPOSIT_EXPIRED = "deposit-expired";

/** The money a card is about: its one move, or every leg of its proposal. */
type CardTarget = { readonly actionId: string } | { readonly proposalId: string };

export function hashOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A fresh grant: random, so nothing can guess it, and short enough for a button. */
function newGrant(): string {
  return randomBytes(16).toString("base64url");
}

/** What a press must still match: every leg as its card shows it and execution will act on it. */
export function legsDigest(legs: readonly ActionRow[]): string {
  return hashOf(legs.map(cardDigest).toSorted().join(","));
}

/**
 * Everything one leg's card showed and execution will act on, so a grant made for one card can't
 * allow a card that changed since. What it showed is its words as well as its numbers: the move's
 * sentence, and its face where it wrote one.
 */
function cardDigest(
  action: Pick<
    ActionRow,
    "id" | "tool" | "venue" | "input" | "details" | "lines" | "amountUsd" | "summary" | "card"
  >,
): string {
  const { id, tool, venue, input, details, lines, amountUsd, summary, card } = action;
  return hashOf(
    canonicalJson({ id, tool, venue, input, details, lines, amountUsd, summary, card }),
  );
}

/** JSON with every object's keys sorted, so the same card always digests the same. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );
}

/** The action rows a sealed card part is about: a money move, a plan, or an ask. */
function cardTarget(card: CardWire): CardTarget | null {
  if (card.kind === "action" || card.kind === "ask") return { actionId: card.actionReference };
  if (card.kind === "action_plan") return { proposalId: card.proposalId };
  return null;
}

export async function legsOf(target: CardTarget): Promise<ActionRow[]> {
  return db
    .select()
    .from(actions)
    .where(
      "actionId" in target
        ? eq(actions.id, target.actionId)
        : eq(actions.proposalId, target.proposalId),
    )
    .orderBy(asc(actions.createdAt), asc(actions.id));
}

function targetOf(delivery: ChannelDeliveryRow): CardTarget | null {
  if (delivery.actionId) return { actionId: delivery.actionId };
  if (delivery.proposalId) return { proposalId: delivery.proposalId };
  return null;
}

/** Auni serves this computer alone unless its Tailscale door is configured. */
export function appDestination(path: string) {
  const origin = new URL(env.WEB_ORIGIN);
  const onPhone =
    env.TAILSCALE_OWNER && origin.protocol === "https:" && origin.hostname.endsWith(".ts.net");
  return { link: onPhone ? new URL(path, origin).href : null, machine: hostname().split(".")[0]! };
}

const threadPath = (threadId: string | null) =>
  threadId ? `/app/chat/${threadId}` : "/app/activity";

const cardPath = (threadId: string, id: string, status = false) =>
  `${threadPath(threadId)}?${new URLSearchParams({ [status ? "status" : "card"]: id })}`;

/** A card asking for a secret, which is typed into its field in the app and never into a chat. */
const asksForSecret = (leg: Pick<ActionRow, "tool">) => leg.tool === "request_secret";

async function viewOf(
  delivery: Pick<ChannelDeliveryRow, "id" | "threadId" | "cardDigest"> | null,
  legs: readonly ActionRow[],
  target: CardTarget,
  threadId = delivery?.threadId ?? legs[0]?.threadId ?? null,
): Promise<CardView> {
  const waiting = waitingOn(legs);
  const id = "actionId" in target ? target.actionId : target.proposalId;
  const thread = threadId ? await threadById(threadId) : null;
  const [secret] = legs.filter(asksForSecret);
  const fits = fitsHere(legs);
  const proof =
    waiting &&
    fits &&
    !secret &&
    (await Promise.all(legs.map((leg) => needsStepUp(leg)))).some(Boolean);
  return {
    legs,
    // A plan's one Allow carries no proof (see allowProposal), so one that takes the owner's is the
    // app's; so is a card asking for a secret, whose field is drawn only there.
    inTheApp: waiting && (!fits || secret !== undefined || proof),
    proof,
    secret: secret !== undefined,
    decidedIn: waiting || !delivery?.cardDigest ? null : await whereDecided(target, delivery.id),
    ...appDestination(threadId ? cardPath(threadId, id) : threadPath(null)),
    statusLink: threadId ? appDestination(cardPath(threadId, id, true)).link : null,
    threadName: thread?.title,
  };
}

/** Where a press decided the card: this message, another channel, or else the app. */
async function whereDecided(target: CardTarget, deliveryId: string): Promise<string> {
  const [won] = await db
    .select({ id: channelDeliveries.id, channel: channelDeliveries.channel })
    .from(channelDeliveries)
    .where(
      and(
        isNotNull(channelDeliveries.decidedAt),
        "actionId" in target
          ? eq(channelDeliveries.actionId, target.actionId)
          : eq(channelDeliveries.proposalId, target.proposalId),
      ),
    )
    .limit(1);
  if (!won) return "the app";
  if (won.id === deliveryId) return "here";
  return channels().find(({ about }) => about.id === won.channel)?.about.name ?? won.channel;
}

/** What a card message records beside what it shows: its grant while it waits for a tap. */
async function drawn(
  delivery: Pick<ChannelDeliveryRow, "id" | "threadId" | "cardDigest"> | null,
  legs: readonly ActionRow[],
  target: CardTarget,
  threadId?: string,
) {
  const view = await viewOf(delivery, legs, target, threadId);
  const digest = legsDigest(legs);
  const waiting = waitingOn(legs);
  const grant = waiting && !view.inTheApp ? newGrant() : null;
  return {
    message: drawCard(view, grant),
    view,
    digest,
    row: {
      shown: shownKey(view, digest),
      open: !legs.every((leg) => SETTLED.includes(leg.status)),
      grantHash: grant ? hashOf(grant) : null,
      grantExpiresAt: grant ? new Date(Date.now() + GRANT_TTL_MS) : null,
      ...(waiting ? { cardDigest: digest } : {}),
    },
  };
}

/** Sends a card to the owner's chat and keeps a record of it; a card about no money links to the app. */
export async function sendCard(
  app: { readonly id: string; readonly channel: Channel },
  chat: string,
  threadId: string,
  card: CardWire,
  messageId?: string,
  replyTo?: string,
  replace?: string,
): Promise<void> {
  const target = cardTarget(card);
  const legs = target ? await legsOf(target) : [];
  if (!target || legs.length === 0) {
    if (card.kind === "deposit") {
      const expired = depositExpired(card);
      const message = await depositMessage(card, threadId, expired, readWallet);
      return recordSent(
        app,
        threadId,
        await app.channel.send(chat, message, replyTo, replace),
        messageId && !card.landed
          ? {
              open: true,
              deposit: { messageId, cardId: card.id },
              shown: expired ? DEPOSIT_EXPIRED : hashOf(JSON.stringify(message)),
            }
          : {},
      );
    }
    const message = drawNotice(card, appDestination(cardPath(threadId, card.id)));
    return recordSent(app, threadId, await app.channel.send(chat, message, replyTo, replace), {});
  }
  const { message, row } = await drawn(null, legs, target, threadId);
  await recordSent(app, threadId, await app.channel.send(chat, message, replyTo, replace), {
    ...("actionId" in target ? { actionId: target.actionId } : { proposalId: target.proposalId }),
    ...row,
  });
}

/** Finds a sealed card to resend, or a read-only notice for a held move without one. */
export async function pendingCard(
  app: { readonly id: string; readonly channel: Channel },
  chat: string,
  row: ActionRow,
): Promise<(() => Promise<void>) | null> {
  const marker = row.proposalId
    ? { kind: "action_plan", proposalId: row.proposalId }
    : { actionReference: row.id };
  const contains = JSON.stringify([{ type: "data-cards", data: { cards: [marker] } }]);
  const [source] = await db
    .select({ threadId: messages.threadId, parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.role, "assistant"), sql`${messages.parts} @> ${contains}::jsonb`))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const segment = replySegments(source?.parts ?? []).find(
    (segment) =>
      segment.kind === "card" &&
      (row.proposalId
        ? segment.card.kind === "action_plan" && segment.card.proposalId === row.proposalId
        : "actionReference" in segment.card && segment.card.actionReference === row.id),
  );
  if (source && segment?.kind === "card")
    return () => sendCard(app, chat, source.threadId, segment.card);
  if (row.phase !== "needs_owner") return null;
  // Without a card to check, the owner can still look at their holdings.
  return async () => {
    const refs = await app.channel.send(chat, drawHeldNotice(row, appDestination("/app")));
    if (row.threadId) await recordSent(app, row.threadId, refs, {});
  };
}

/** Keeps each message a send took, so a reply to any of them joins the thread; `last` has the buttons. */
export async function recordSent(
  app: { readonly id: string },
  threadId: string,
  refs: readonly string[],
  last: Partial<typeof channelDeliveries.$inferInsert>,
): Promise<void> {
  if (refs.length === 0) return;
  await db.insert(channelDeliveries).values(
    refs.map((ref, index) => ({
      channel: app.id,
      ref,
      threadId,
      ...(index === refs.length - 1 ? last : {}),
    })),
  );
}

/**
 * Redraws one card message when what it shows has changed, or its grant is spent or old while it
 * still waits for a tap, which then gets a fresh grant; one whose moves have all settled is done.
 */
export async function syncDelivery(
  delivery: ChannelDeliveryRow,
  depositWallet = readWallet,
): Promise<void> {
  const target = targetOf(delivery);
  const app = channels(offered()).find(({ about }) => about.id === delivery.channel);
  if (!app?.channel.configured()) return;
  if (delivery.deposit) return syncDeposit(app.channel, delivery, delivery.deposit, depositWallet);
  if (!target) return;
  const legs = await legsOf(target);
  if (legs.length === 0) {
    await db
      .update(channelDeliveries)
      .set({ open: false })
      .where(eq(channelDeliveries.id, delivery.id));
    return;
  }
  const view = await viewOf(delivery, legs, target);
  const digest = legsDigest(legs);
  const tapping = waitingOn(legs) && !view.inTheApp;
  const grantLive =
    delivery.grantHash !== null &&
    delivery.grantExpiresAt !== null &&
    delivery.grantExpiresAt.getTime() > Date.now() &&
    delivery.cardDigest === digest;
  if (shownKey(view, digest) === delivery.shown && (!tapping || grantLive)) return;
  const { message, row } = await drawn(delivery, legs, target);
  // Recorded only once it shows: a grant the message never carried can't be pressed, and one it
  // carries that wasn't recorded is drawn again next time. A message that's gone (the owner
  // deleted it) can't show anything or be pressed again, so it's done, and its grant with it.
  const shows = await app.channel.edit(delivery.ref, message);
  await db
    .update(channelDeliveries)
    .set(shows ? row : { open: false, grantHash: null, grantExpiresAt: null })
    .where(eq(channelDeliveries.id, delivery.id));
}

function depositExpired(card: DepositCardWire): boolean {
  return Date.now() >= Date.parse(card.updatedAt) + DEPOSIT_WAIT_MS;
}

const readWallet = () => walletAddresses().catch(() => undefined);

async function depositMessage(
  card: DepositCardWire,
  threadId: string,
  expired: boolean,
  depositWallet: typeof readWallet,
) {
  const wallet = !card.landed && !expired ? await depositWallet() : undefined;
  return drawNotice(card, appDestination(cardPath(threadId, card.id)), wallet, expired);
}

async function syncDeposit(
  channel: Channel,
  delivery: ChannelDeliveryRow,
  deposit: NonNullable<ChannelDeliveryRow["deposit"]>,
  depositWallet: typeof readWallet,
): Promise<void> {
  const [answer] = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.id, deposit.messageId), eq(messages.threadId, delivery.threadId)));
  const segment = replySegments(answer?.parts ?? []).find(
    (part) => part.kind === "card" && part.card.id === deposit.cardId,
  );
  const card = segment?.kind === "card" ? segment.card : undefined;
  if (card?.kind === "deposit") {
    const expired = depositExpired(card);
    const message = await depositMessage(card, delivery.threadId, expired, depositWallet);
    const shown = expired ? DEPOSIT_EXPIRED : hashOf(JSON.stringify(message));
    if (!card.landed && delivery.shown === shown) return;
    const edited = await channel.edit(delivery.ref, message);
    if (edited && !card.landed) {
      await db
        .update(channelDeliveries)
        .set({ shown })
        .where(eq(channelDeliveries.id, delivery.id));
      return;
    }
  }
  await db
    .update(channelDeliveries)
    .set({ open: false })
    .where(eq(channelDeliveries.id, delivery.id));
}

/** An expired watch can still land if the sweep learns later that money came before its deadline. */
const depositToSync = and(
  isNotNull(channelDeliveries.deposit),
  or(
    sql`${channelDeliveries.shown} is distinct from ${DEPOSIT_EXPIRED}`,
    sql`exists (
    select 1 from ${messages}
    where ${messages.id} = (${channelDeliveries.deposit}->>'messageId')::uuid
      and jsonb_path_exists(
        ${messages.parts},
        '$[*] ? (@.type == "data-cards").data.cards[*] ? (@.id == $card && @.kind == "deposit" && @.landed != null)',
        jsonb_build_object('card', ${channelDeliveries.deposit}->>'cardId')
      )
  )`,
  ),
);

/** Brings every card message still in play up to date with its moves. */
export async function syncCards(): Promise<void> {
  const open = await db
    .select()
    .from(channelDeliveries)
    .where(
      and(
        eq(channelDeliveries.open, true),
        or(
          isNotNull(channelDeliveries.actionId),
          isNotNull(channelDeliveries.proposalId),
          depositToSync,
        ),
      ),
    );
  let wallet: ReturnType<typeof readWallet> | undefined;
  for (const delivery of open) {
    try {
      await syncDelivery(delivery, () => (wallet ??= readWallet()));
    } catch (error) {
      console.error(`channel card ${delivery.id} couldn't be redrawn`, error);
    }
  }
}

/**
 * Spends a grant pressed on one message, once: the delivery it was on, or null for a grant that
 * isn't that message's, was spent already, or is past its day.
 */
export async function spendGrant(
  channel: string,
  ref: string,
  grant: string,
): Promise<ChannelDeliveryRow | null> {
  const [spent] = await db
    .update(channelDeliveries)
    .set({ grantHash: null, grantExpiresAt: null })
    .where(
      and(
        eq(channelDeliveries.channel, channel),
        eq(channelDeliveries.ref, ref),
        eq(channelDeliveries.grantHash, hashOf(grant)),
        gt(channelDeliveries.grantExpiresAt, sql`now()`),
      ),
    )
    .returning();
  return spent ?? null;
}
