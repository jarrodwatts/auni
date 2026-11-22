import type { HoldingWire, ThreadId, ThreadWire, UsdcMoneyWire } from "@auni/shared";

/**
 * What the screens show of core's data: its wire shapes (in @auni/shared),
 * already checked when lib/data read them, with dollars turned into base-unit
 * money and a few fields named for the screens.
 */

/** One position as a person reads it: a real name, a quiet detail line, its value. */
export interface Holding extends Pick<HoldingWire, "id" | "name" | "detail" | "logoUrl"> {
  readonly value: UsdcMoneyWire;
  /** Signed USDC base units over the last 24 hours; null when no price history was readable. */
  readonly todayChangeBaseUnits: string | null;
}

/** One point of a value over time, as the charts draw it. */
export interface BalanceHistoryPoint {
  readonly observedAt: string;
  readonly totalUsd: UsdcMoneyWire;
  /** Signed: what it had made by then, net of money added or taken out. */
  readonly made: UsdcMoneyWire;
}

/** A value over one range, and when it first held money, which says what ranges it covers. */
export interface ValueHistory {
  readonly startedAt: string | null;
  readonly points: readonly BalanceHistoryPoint[];
}

/** A conversation as the sidebar, thread inspector, and composer show it. */
export interface Thread {
  readonly id: ThreadId;
  readonly title: string;
  readonly state: "needs_user" | "running" | "done";
  /** What the thread waits on the person for, in one line. */
  readonly moneyLine: string | null;
  /** Auni's last answer asks the person something they haven't answered. */
  readonly asking: boolean;
  /** Auni answered since the person last read it. */
  readonly unread: boolean;
  /**
   * The money allowed here, by legs: how many went through and how many didn't,
   * of all of them. Set while any leg runs, and once all have settled until the
   * person reads the thread.
   */
  readonly moving: ThreadWire["moving"];
  /** Whether this thread asks before every move or acts on its own within its budget. */
  readonly actMode: ThreadWire["actMode"];
  /** Dollar spending limit when actMode is "within_limits". */
  readonly budgetUsd: string;
  /** Working notes Auni keeps for this thread. */
  readonly notes: string | null;
  /** Per-thread brain, model, and effort override; null inherits the owner's default. */
  readonly modelSelection: ThreadWire["modelSelection"];
  /** Pinned at the top of the sidebar. */
  readonly pinned: boolean;
  readonly pinnedAt: string | null;
  /** Active watches attached to this thread. */
  readonly watchCount: number;
  /** Completed money moves opened in this thread. */
  readonly moveCount: number;
  /** Archived by the person: out of Threads, found by search, back once they or Auni say something new there. */
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Live holdings opened in one thread and its remaining auto-spend budget. */
export interface ThreadState {
  readonly budgetUsd: string;
  readonly freeBudgetUsd: string;
  readonly holdings: readonly Holding[];
}

export interface ThreadSearchResult {
  readonly thread: Thread;
  readonly source: "title" | "message";
  readonly snippet: string | null;
  readonly messageRole: "user" | "assistant" | null;
  readonly messageCreatedAt: string | null;
}
