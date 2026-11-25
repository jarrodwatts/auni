import type {
  ActionLine,
  ActionStatus,
  MovePhase,
  MoveRun,
  AutomationStatus,
  CardFace,
  FailureKind,
  FireVerdict,
  ModelSelectionWire,
  OwnerSignals,
  StartingPoint,
  ThreadActMode,
  WatchedWallet,
} from "@auni/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type { Schedule } from "../automations/schedule.ts";
import type { WatchFire } from "../conversation/history.ts";
import type { ArrivalKind } from "../money/arrivals.ts";
import type { ReadingHolding } from "../money/portfolio.ts";

// Money is always numeric/decimal-string, never float. Status-ish columns are
// free text plus a CHECK: cheaper to extend with a new value than an enum migration.
const TIMESTAMPTZ = { withTimezone: true, mode: "date", precision: 3 } as const;

// The owner's settings: Auni runs for one person, so this is one row (id 1), made by the
// migration that made the table. Read it with theOwner() (auth/owner.ts).
export const owner = pgTable(
  "owner",
  {
    id: integer("id").primaryKey().default(1),
    name: text("name"),
    timeZone: text("time_zone").default("UTC").notNull(),
    // When their brief comes, a schedule on their own clock (automations/schedule.ts): every
    // day at 08:00 unless they say otherwise, null for none; and when the last was written
    // (automations/brief.ts).
    brief: jsonb("brief").$type<Schedule>().default({ every: "day", at: "08:00" }),
    lastBriefAt: timestamp("last_brief_at", TIMESTAMPTZ),
    // Where background answers go (channels/home.ts): a channel app's id, "web" for the web
    // app alone, or null for wherever they last talked to Auni, which last_channel keeps (null:
    // the web).
    homeChannel: text("home_channel"),
    lastChannel: text("last_channel"),
    // The owner's default brain, model and effort for new threads; null for automatic.
    defaultModelSelection: jsonb("default_model_selection").$type<ModelSelectionWire | null>(),
    // When they last looked at their activity: what didn't come from them since is unread.
    activitySeenAt: timestamp("activity_seen_at", TIMESTAMPTZ).defaultNow().notNull(),
    // First run (setup.ts): when they said they saved their wallet's spare key somewhere safe,
    // or that they'd save it later, and when they sent their first message, which finishes first run.
    backupSavedAt: timestamp("backup_saved_at", TIMESTAMPTZ),
    backupLaterAt: timestamp("backup_later_at", TIMESTAMPTZ),
    welcomedAt: timestamp("welcomed_at", TIMESTAMPTZ),
    // A new thread's starting points (conversation/starting-points.ts), kept so they show at once,
    // and when they were written: a day later the next thread opened asks for new ones.
    startingPoints: jsonb("starting_points").$type<StartingPoint[]>(),
    startingPointsAt: timestamp("starting_points_at", TIMESTAMPTZ),
    // When they answered the web's ask for a star on GitHub (github-star.ts), from any device:
    // starred, not now, or closed. It is never asked again.
    starPromptAnsweredAt: timestamp("star_prompt_answered_at", TIMESTAMPTZ),
    // Visual look synced across devices and editable by Auni ("light", "dark", or app theme id).
    look: text("look"),
    // Owner's public X/Twitter handle (without @) and watch-only public addresses for tailored prompts.
    xHandle: text("x_handle"),
    watchedWallets: jsonb("watched_wallets").$type<WatchedWallet[]>().default([]).notNull(),
    // Auto-learned (and owner-editable) short profile of what Auni knows about the owner.
    profileSummary: text("profile_summary"),
    // Latest signal snapshot read from X and watched wallets (signals.ts).
    profileSignals: jsonb("profile_signals").$type<OwnerSignals | null>(),
  },
  (table) => [check("owner_one_row_check", sql`${table.id} = 1`)],
);

/** What a thread's latest turn has left on record as it went (conversation/turn-record.ts). */
export interface TurnRecord {
  /** The turn it is of: a message's id, or a background turn's job id. */
  readonly turn: string;
  /** When the turn began, by the database's clock. */
  readonly began: string;
  /** What it has shown so far, as its answer's parts. */
  readonly parts: readonly unknown[];
  /** It called one of Auni's tools: written before the first one runs. */
  readonly usedTool?: true;
  /** It ended, written with its answer when it left one: it never runs again. */
  readonly ended?: true;
}

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title"),
    // How Auni acts on moves in this thread: ask_first waits for a tap on every move;
    // within_limits acts on its own within budgetUsd for buys and sells of what this thread bought.
    actMode: text("act_mode").$type<ThreadActMode>().default("ask_first").notNull(),
    budgetUsd: numeric("budget_usd", { precision: 14, scale: 2 }).default("0.00").notNull(),
    // Working notes Auni rewrites as an ongoing thread evolves, shown in the thread inspector.
    notes: text("notes"),
    // Explicit brain, model and effort chosen for this thread; null uses owner/auto default.
    modelSelection: jsonb("model_selection").$type<ModelSelectionWire | null>(),
    // Pinned by the owner to the top of the sidebar.
    pinnedAt: timestamp("pinned_at", TIMESTAMPTZ),
    // Set when the agent asks to be woken by the next deposit; cleared when one lands. A day
    // on it wakes nothing (DEPOSIT_WAIT_MS).
    awaitingDepositSince: timestamp("awaiting_deposit_since", TIMESTAMPTZ),
    // The tokens its latest deposit card named, by fillIdentity ("base:0xabc…"): one landing
    // becomes theirs (see money/buckets.ts). Kept past the wait, which any deposit ends, until
    // a later card names others.
    expectedTokens: text("expected_tokens")
      .array()
      .default(sql`'{}'`)
      .notNull(),
    // Put away by the owner: out of the sidebar, still found by search. An answer brings it back.
    archivedAt: timestamp("archived_at", TIMESTAMPTZ),
    // Set while a turn is queued or running; its presence is the thread's "running" status.
    turnStartedAt: timestamp("turn_started_at", TIMESTAMPTZ),
    // Its latest turn's record, written as the turn goes: a turn cut off when Auni dies is
    // judged, and kept as far as the owner saw it, from this (conversation/turn-record.ts).
    answerSoFar: jsonb("answer_so_far").$type<TurnRecord>(),
    // When Auni last left an answer here, and when the person last looked; a newer answer is unread.
    repliedAt: timestamp("replied_at", TIMESTAMPTZ),
    readAt: timestamp("read_at", TIMESTAMPTZ),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    check("threads_act_mode_check", sql`${table.actMode} in ('ask_first', 'within_limits')`),
  ],
);

export interface MessageMetadata {
  /** The person stopped this answer before it finished. */
  readonly stopped?: true;
  /** The turn failed; the parts hold whatever streamed before it did. */
  readonly failed?: true;
  /** No AI could think, which the owner can fix from the app (conversation/turn.ts). */
  readonly noBrain?: true;
  readonly workDurationMs?: number;
  /** The brain app that thought it, the model it said it used, and whose login paid. */
  readonly brain?: string;
  readonly model?: string;
  readonly login?: string;
  /** Why a background turn ran (an automation fired, an action finished). */
  readonly reason?: string;
  /** The watches whose firing started this answer (triage folds close fires into one turn). */
  readonly fires?: WatchFire[];
  /** A background answer that settled quietly: nothing worth telling, and why. */
  readonly quiet?: string;
  /** The channel app the owner sent this message from; unset, the web app. */
  readonly channel?: string;
  /** Message to reply to on the originating channel. */
  readonly channelRef?: string;
  /** Core left it outside any turn (money arriving, a pasted key kept out): no AI worked on it. */
  readonly posted?: true;
}

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    role: text("role").$type<"user" | "assistant">().notNull(),
    parts: jsonb("parts").$type<unknown[]>().notNull(),
    // The message this one replaces (e.g. an edited user turn). Self-FK, so
    // it needs the AnyPgColumn callback form to dodge circular inference.
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => messages.id),
    origin: text("origin").$type<"human" | "automation">().default("human").notNull(),
    metadata: jsonb("metadata").$type<MessageMetadata>().default({}).notNull(),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    index("messages_thread_idx").on(table.threadId),
    check("messages_role_check", sql`${table.role} in ('user', 'assistant')`),
    check("messages_origin_check", sql`${table.origin} in ('human', 'automation')`),
  ],
);

/** How one earlier run of an action ended, kept when the person tries it again. */
export interface PreviousError {
  readonly error: string | null;
  readonly kind: FailureKind | null;
  readonly at: string;
}

export const actions = pgTable(
  "actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Null for a withdrawal started from Settings, outside every conversation.
    threadId: uuid("thread_id").references(() => threads.id),
    // Legs of one proposal card share this id; one Allow covers them all.
    proposalId: uuid("proposal_id"),
    summary: text("summary").notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 }).notNull(),
    // Where it stands, and while it is running, how far it has got. Only money/life.ts writes
    // these two and startedAt: it is the whole of a move's life.
    status: text("status").$type<ActionStatus>().notNull(),
    phase: text("phase").$type<MovePhase>(),
    venue: text("venue"),
    tool: text("tool").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    // What the card shows, in order; jsonb keeps an array's order, not an object's.
    lines: jsonb("lines").$type<ActionLine[]>().default([]).notNull(),
    // What code pinned when the card was made: the bounds its tap approves, addresses, mints,
    // and facts its card shows. Written once with the row, and never after.
    details: jsonb("details").$type<Record<string, string>>().default({}).notNull(),
    // What its run wrote down as it went: where it lands, what a sale brought back.
    run: jsonb("run").$type<MoveRun>().default({}).notNull(),
    // What the card says, in the move's own words; null for a move core's plain face says.
    card: jsonb("card").$type<CardFace>(),
    // A send is kept by its wallet's own id for it (walletTxId), or a venue's relayer's, until
    // its hash comes back, and by both when the wallet can answer for a hash the chain can't yet.
    txs: jsonb("txs")
      .$type<
        {
          readonly chain: string;
          readonly hash?: string;
          readonly walletTxId?: string;
          readonly relayerId?: string;
          readonly setup?: true;
          /**
           * On the send that bought a chain's coin for the move's fees (money/fee-coin.ts,
           * money/sol-top-up.ts): the pay-in service's id for that order, also on the
           * service's transaction that paid the wallet for it, or "swap" for a swap on the
           * chain itself. A card makes one such purchase, ever.
           */
          readonly buysFees?: string;
        }[]
      >()
      .default([])
      .notNull(),
    error: text("error"),
    // Why it stopped, beside its error (see failure.ts); null while it hasn't, and once done.
    failureKind: text("failure_kind").$type<FailureKind>(),
    // Its runs: a failed step the person tries again runs once more, as the next attempt.
    attempts: integer("attempts").default(1).notNull(),
    // How each earlier run ended, oldest first.
    previousErrors: jsonb("previous_errors").$type<PreviousError[]>().default([]).notNull(),
    // When the executor claimed it and money started moving.
    startedAt: timestamp("started_at", TIMESTAMPTZ),
    // When its run ended (done, failed, or sent and left landing or unsure): what its orders
    // filled before then its own card tells, and a fill after it (a stop, a limit left resting)
    // is news (money/statements.ts, filledLater).
    endedAt: timestamp("ended_at", TIMESTAMPTZ),
    // When the owner proved they were there as they allowed this very card (auth/proof.ts), for
    // a move a tap can't vouch for (money/step-up.ts). Execution checks it, so no path around the
    // proof can send.
    stepUpAt: timestamp("step_up_at", TIMESTAMPTZ),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    index("actions_thread_idx").on(table.threadId),
    index("actions_proposal_idx").on(table.proposalId),
    check(
      "actions_status_check",
      sql`${table.status} in ('awaiting_permission', 'running', 'done', 'failed', 'cancelled', 'replaced', 'retracted')`,
    ),
    check(
      "actions_phase_check",
      sql`${table.phase} in ('queued', 'sending', 'landing', 'unsure', 'needs_owner')`,
    ),
    // A running move always says how far it has got, and nothing else does.
    check(
      "actions_running_phase_check",
      sql`(${table.status} = 'running') = (${table.phase} is not null)`,
    ),
  ],
);

export const fills = pgTable(
  "fills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    instrument: text("instrument").notNull(),
    chain: text("chain").notNull(),
    side: text("side").$type<"buy" | "sell">().notNull(),
    quantity: numeric("quantity", { precision: 38, scale: 18 }).notNull(),
    usdValue: numeric("usd_value", { precision: 14, scale: 2 }).notNull(),
    /**
     * What it locked in, signed, as its venue's statement says it: the profit or loss on the part
     * of a position it closed, 0 for one that opened. Null where the venue says none.
     */
    pnlUsd: numeric("pnl_usd", { precision: 20, scale: 6 }),
    /**
     * The line of the venue's statement it was read from (see statements.ts):
     * "<venue>:<address>:<trade id>". A line split between threads is a row
     * per thread, each recorded once. Null for a fill Auni worked out itself.
     */
    venueRef: text("venue_ref"),
    /** When it happened: as the venue dates it, for one read from its statement. */
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    index("fills_action_idx").on(table.actionId),
    index("fills_thread_idx").on(table.threadId),
    uniqueIndex("fills_venue_ref_idx").on(
      table.venueRef,
      sql`coalesce(${table.threadId}, '00000000-0000-0000-0000-000000000000')`,
    ),
    check("fills_side_check", sql`${table.side} in ('buy', 'sell')`),
  ],
);

// A watch: what to look out for, in its source's own words, and the thread it wakes when it
// comes true. The source (an app) watches; the hub here keeps the rest (automations/).
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    // The app that watches, and its own id for the watch when it keeps one (RemoteWatching).
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    // When the source's watch ends unless renewed; null for a source Auni runs itself.
    leaseUntil: timestamp("lease_until", TIMESTAMPTZ),
    // The source's condition, as its schema took it.
    condition: jsonb("condition").$type<Record<string, unknown>>().notNull(),
    // The line the owner sees ("ETH falls below $2,000"), and the agent's note on why it matters.
    description: text("description").notNull(),
    note: text("note").notNull(),
    // Null fires once; otherwise the least time between fires that wake the thread ("0", "1h").
    repeat: text("repeat"),
    status: text("status").$type<AutomationStatus>().default("active").notNull(),
    // Null watches until deleted.
    expiresAt: timestamp("expires_at", TIMESTAMPTZ),
    lastFiredAt: timestamp("last_fired_at", TIMESTAMPTZ),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    index("automations_thread_idx").on(table.threadId),
    uniqueIndex("automations_source_ref_idx").on(table.source, table.sourceRef),
    check(
      "automations_status_check",
      sql`${table.status} in ('active', 'paused', 'triggered', 'expired', 'cancelled', 'failed', 'deleted')`,
    ),
  ],
);

export const automationFires = pgTable(
  "automation_fires",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id),
    // The source's id for the fire, unique within its watch, so a fire told twice is recorded once.
    eventId: text("event_id").notNull(),
    // What the source reported.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // The story it was about, so a later report on it doesn't wake the thread again.
    storylineId: text("storyline_id"),
    // When it happened, as the source told it; caught up after a sleep, earlier than created_at.
    happenedAt: timestamp("happened_at", TIMESTAMPTZ).notNull(),
    // It happened while Auni was asleep or offline, and was found catching up.
    late: boolean("late").default(false).notNull(),
    // Null while triage judges it (automations/triage.ts); 'quiet' when the hub held it back.
    verdict: text("verdict").$type<FireVerdict>(),
    // Triage's one line on why.
    reason: text("reason"),
    // When a fire held for the brief was handed to one.
    briefedAt: timestamp("briefed_at", TIMESTAMPTZ),
    // The answer this fire woke, and its opening line: what happened and what Auni made of it.
    messageId: uuid("message_id").references(() => messages.id),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    index("automation_fires_automation_idx").on(table.automationId),
    uniqueIndex("automation_fires_event_idx").on(table.automationId, table.eventId),
    check(
      "automation_fires_verdict_check",
      sql`${table.verdict} in ('quiet', 'wake', 'brief', 'note')`,
    ),
  ],
);

// Where each source's run got to, saved once the fires before it were recorded (automations/sources.ts).
export const sourceCursors = pgTable("source_cursors", {
  source: text("source").primaryKey(),
  cursor: text("cursor").notNull(),
  savedAt: timestamp("saved_at", TIMESTAMPTZ).defaultNow().notNull(),
});

/**
 * What keeps going wrong for an app while Auni runs, one row per app and piece of work, kept from
 * its first failure until that work next goes right (app-troubles.ts). The Apps sheet and
 * `auni doctor` read it, so a service that ran out of credits or retired what Auni asks shows
 * where the owner looks, not only in the log.
 */
export const appTroubles = pgTable(
  "app_troubles",
  {
    app: text("app").notNull(),
    /** The work that failed, as a person names it: "reading payouts", "watching". */
    work: text("work").notNull(),
    kind: text("kind").$type<"credits" | "failing">().notNull(),
    /** What the service or the error said, safe to show (safe-words.ts). */
    said: text("said").notNull(),
    since: timestamp("since", TIMESTAMPTZ).defaultNow().notNull(),
    lastAt: timestamp("last_at", TIMESTAMPTZ).defaultNow().notNull(),
    times: integer("times").default(1).notNull(),
  },
  (table) => [primaryKey({ columns: [table.app, table.work] })],
);

export const valueSnapshots = pgTable(
  "value_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    usdValue: numeric("usd_value", { precision: 14, scale: 2 }).notNull(),
    // The plain cash within usd_value (money/made.ts).
    cashUsd: numeric("cash_usd", { precision: 14, scale: 2 }),
    // What the reading held, so value between readings can be priced from it.
    holdings: jsonb("holdings").$type<readonly ReadingHolding[]>(),
    takenAt: timestamp("taken_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [index("value_snapshots_taken_idx").on(table.takenAt)],
);

// One transfer into or out of the wallet, read from its transaction on the
// chain and told apart once (see money/arrivals.ts). Keyed by where it sits in
// that transaction, so a replayed sweep records nothing twice.
export const arrivals = pgTable(
  "arrivals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chain: text("chain").notNull(),
    txHash: text("tx_hash").notNull(),
    // "log:2" or "call:3" on an EVM chain, counted within the transaction, so a reorg
    // can't change it; on Solana the mint, or "native".
    position: text("position").notNull(),
    // What moved, as a fill names it (money/fill-key.ts).
    instrument: text("instrument").notNull(),
    // Negative when it left the wallet.
    baseUnits: numeric("base_units", { precision: 78, scale: 0 }).notNull(),
    decimals: integer("decimals").notNull(),
    // Its dollars when it moved, signed as base_units; null for a token with no price.
    usdValue: numeric("usd_value", { precision: 14, scale: 2 }),
    // Its name as it was recorded, by its bucket's rule (see tokenName in money/buckets.ts).
    symbol: text("symbol"),
    // Who the chain says was on the other side: who sent money in, or where money out went.
    counterparty: text("counterparty"),
    kind: text("kind").$type<ArrivalKind>().notNull(),
    // The action it belongs to: Auni's own move, or one landing.
    actionId: uuid("action_id").references(() => actions.id),
    // When its block was made.
    at: timestamp("at", TIMESTAMPTZ).notNull(),
    // Its block, or Solana slot: whether a token's worth read at a block holds it already
    // (see keptBlock).
    block: bigint("block", { mode: "number" }).notNull(),
    // When it starts counting as money put in or taken out: the first moment from `at`
    // a reading held what moved, which is when it was recorded for a token Auni didn't
    // yet read (see readFrom in money/portfolio.ts).
    countsFrom: timestamp("counts_from", TIMESTAMPTZ).defaultNow().notNull(),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("arrivals_transfer_idx").on(table.chain, table.txHash, table.position),
    index("arrivals_counts_from_idx").on(table.countsFrom),
    check(
      "arrivals_kind_check",
      sql`${table.kind} in ('own_move', 'landing', 'payout', 'external_out', 'deposit')`,
    ),
  ],
);

// A token in the wallet that isn't plainly the owner's by their fills (see
// money/buckets.ts): one Auni doesn't recognise, seen arriving, which costs
// this row and nothing more; and any holding counted from then on, as money put
// in: one Auni found already there when it first looked (money/first-look.ts),
// one that landed counted, one they added or set Auni to trade, or one Auni
// came to recognise. An EVM token by its lowercased address, a Solana one by
// its mint, a holding at an app's account as that account names it.
export const otherTokens = pgTable(
  "other_tokens",
  {
    chain: text("chain").notNull(),
    instrument: text("instrument").notNull(),
    seenAt: timestamp("seen_at", TIMESTAMPTZ).defaultNow().notNull(),
    // When it began to count, and is theirs from then; null while it is only seen. A wallet
    // token begins only by startCounting in money/other-tokens.ts, with kept_block; a
    // holding at an app's account only by its account's first look, with none.
    keptAt: timestamp("kept_at", TIMESTAMPTZ),
    // What it held then was worth, as money put in (see arrivalFlows in money/made.ts). Null
    // with no price, which counts as nothing, as the portfolio counts it.
    keptUsd: numeric("kept_usd", { precision: 14, scale: 2 }),
    // The block, or Solana slot, kept_usd was read at: whatever moved there or before is in
    // it, so counts in no arrival of it, and whatever moved after counts as its arrival does
    // (see arrivalFlows in money/made.ts). Null for a holding at an app's account, which no
    // arrival moves.
    keptBlock: bigint("kept_block", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.instrument] }),
    check(
      "other_tokens_kept_check",
      sql`${table.keptAt} is not null or ${table.keptBlock} is null`,
    ),
  ],
);

// Each place Auni reads money at that it has looked at once, by name (see placeOf in
// money/first-look.ts): the wallet on a chain, found token by token, or an app's account,
// whose first read lists all it holds. What a first look found was already there, so it
// counted as money put in (other_tokens), and a later look finds only what moved since.
export const firstLooks = pgTable("first_looks", {
  place: text("place").primaryKey(),
  lookedAt: timestamp("looked_at", TIMESTAMPTZ).defaultNow().notNull(),
});

// How far the wallet on each network has been swept for arrivals: the
// last block, or Solana slot, through which every transaction has been read.
// A venue's statement keeps its cursor here too, under the venue's name, as
// the time in milliseconds through which every line has been read (see
// statements.ts).
// Solana lists newest first, so a listing a flood stopped short of the cursor
// keeps, by address, the oldest transaction it read, for the next to list on
// from (see solanaTxs).
export const arrivalCursors = pgTable("arrival_cursors", {
  chain: text("chain").primaryKey(),
  block: bigint("block", { mode: "number" }).notNull(),
  resume: jsonb("resume")
    .$type<Record<string, { hash: string; block: number }>>()
    .default({})
    .notNull(),
});

/**
 * What lets a browser act as the owner. A pairing code is printed where Auni runs and works once
 * for 15 minutes; spending it makes a session, whose token is the browser's cookie. Only hashes
 * are kept, so reading the table hands nobody a way in.
 */
export const ownerSessions = pgTable(
  "owner_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind").$type<"pairing" | "session">().notNull(),
    label: text("label"),
    userAgent: text("user_agent"),
    lastSeenAt: timestamp("last_seen_at", TIMESTAMPTZ),
    // Browser-issued pairing links pair a normal session but never grant or renew step-up proof.
    browserIssued: boolean("browser_issued").default(false).notNull(),
    expiresAt: timestamp("expires_at", TIMESTAMPTZ).notNull(),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [check("owner_sessions_kind_check", sql`${table.kind} in ('pairing', 'session')`)],
);

// Background work, run by core's job runner (jobs/runner.ts): a turn, a move, a check on money
// landing, a cron. A row is queued in the same transaction as the change that needs it, so the
// two commit together or not at all.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    // Queued once per key: a message id, a wake's id, "cron:reconcile". Null for no dedupe.
    key: text("key").unique(),
    data: jsonb("data").$type<unknown>().notNull(),
    // Two jobs sharing a lane never run at once: one turn a thread, one move a venue.
    lanes: text("lanes")
      .array()
      .default(sql`'{}'`)
      .notNull(),
    runAt: timestamp("run_at", TIMESTAMPTZ).defaultNow().notNull(),
    startedAt: timestamp("started_at", TIMESTAMPTZ),
    finishedAt: timestamp("finished_at", TIMESTAMPTZ),
    outcome: text("outcome").$type<JobOutcome>(),
    error: text("error"),
    // Tries of its current run, retries included; its next run (`again`, a cron) counts afresh.
    attempts: integer("attempts").default(0).notNull(),
    // The clock, not the transaction's start, and to the microsecond, so jobs queued together
    // run in the order queued.
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    index("jobs_open_idx")
      .on(table.runAt)
      .where(sql`${table.finishedAt} is null`),
    check(
      "jobs_outcome_check",
      sql`${table.outcome} in ('done', 'failed', 'interrupted', 'cancelled')`,
    ),
  ],
);

/** How a job ended: ran, threw past its retries, was cut off by a crash, or was cancelled unstarted. */
export type JobOutcome = "done" | "failed" | "interrupted" | "cancelled";

/**
 * The owner on each channel app (channels/hub.ts): their stable id there and their direct chat
 * with Auni, set by a one-time code they send from it, of which only the hash is kept.
 */
export const channelLinks = pgTable("channel_links", {
  /** The channel app's id. */
  channel: text("channel").primaryKey(),
  /** Null until a code is spent. */
  owner: text("owner"),
  chat: text("chat"),
  pairingHash: text("pairing_hash"),
  pairingExpiresAt: timestamp("pairing_expires_at", TIMESTAMPTZ),
  pairedAt: timestamp("paired_at", TIMESTAMPTZ),
});

/** A question sent with its answers as buttons, in order. */
export interface ChannelQuestion {
  readonly text: string;
  readonly options: readonly string[];
}

/**
 * Each message Auni sent on a channel, so a reply to it joins its thread, and a card's message
 * keeps in step with its moves. A card waiting for a tap carries a grant on its buttons: random,
 * kept here only as a hash, bound to this message and to the card as it waited (its digest), spent
 * by one press, and dead after a day. Neither the agent nor its tools ever see one.
 */
export const channelDeliveries = pgTable(
  "channel_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channel: text("channel").notNull(),
    /** The channel's id for the message. */
    ref: text("ref").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    /** A card's one move, or its proposal's legs. */
    actionId: uuid("action_id").references(() => actions.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id"),
    question: jsonb("question").$type<ChannelQuestion>(),
    /** A deposit card edits in place when this answer records what landed. */
    deposit: jsonb("deposit").$type<{ readonly messageId: string; readonly cardId: string }>(),
    grantHash: text("grant_hash").unique(),
    grantExpiresAt: timestamp("grant_expires_at", TIMESTAMPTZ),
    /** The card as it waited for the owner, which a press must still match; null if it never waited. */
    cardDigest: text("card_digest"),
    /** A press on this message decided the card. */
    decidedAt: timestamp("decided_at", TIMESTAMPTZ),
    /** A digest of what the message shows now. */
    shown: text("shown"),
    /** A card still to keep in step, or a question still to answer. */
    open: boolean("open").default(false).notNull(),
    createdAt: timestamp("created_at", TIMESTAMPTZ).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("channel_deliveries_ref_unique").on(table.channel, table.ref),
    index("channel_deliveries_action_idx").on(table.actionId),
    index("channel_deliveries_proposal_idx").on(table.proposalId),
    index("channel_deliveries_open_idx")
      .on(table.open)
      .where(sql`${table.open}`),
  ],
);

export type ChannelLinkRow = typeof channelLinks.$inferSelect;
export type ChannelDeliveryRow = typeof channelDeliveries.$inferSelect;

export type OwnerRow = typeof owner.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type AutomationRow = typeof automations.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
