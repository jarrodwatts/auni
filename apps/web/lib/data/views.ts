import type {
  SpecialistId,
  SpecialistWire,
  HoldingWire,
  ThreadId,
  ThreadWire,
  UsdcMoneyWire,
} from "@auni/shared";

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

export interface Specialist extends Pick<
  SpecialistWire,
  | "id"
  | "kind"
  | "name"
  | "purpose"
  | "pulse"
  | "notes"
  | "report"
  | "status"
  | "rules"
  | "potUsd"
  | "startedIn"
> {
  /** Picks the glyph a large orb carries; unknown themes fall back to a neutral one. */
  readonly theme: string;
  readonly startedAt: string;
  /** When it retired; null while it works. */
  readonly retiredAt: string | null;
  readonly value: UsdcMoneyWire;
  /** Signed: what it has made, net of the money its trades put in or took out. */
  readonly made: UsdcMoneyWire;
  /** Signed USDC base units since the start of today, net the same way. */
  readonly todayChangeBaseUnits: string;
  readonly holdings: readonly Holding[];
}

/** Money outside every specialist: what one-off chats left behind, and idle cash. */
export interface LooseHoldings {
  readonly other: readonly Holding[];
  readonly cash: Holding;
  /** How many tokens sit in their wallets that Auni doesn't count: anyone can send one. */
  readonly otherTokens: number;
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

/** A conversation as the sidebar and places show it. */
export interface Thread {
  readonly id: ThreadId;
  /** The specialist this conversation belongs to; null for a chat. */
  readonly specialistId: SpecialistId | null;
  readonly title: string;
  readonly state: "needs_user" | "running" | "done";
  /** What the thread waits on the person for, in one line: "Waiting for your OK · $150". */
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
  /** Archived by the person: out of History, found by search, back once they or Auni say something new there. */
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadSearchResult {
  readonly thread: Thread;
  readonly source: "title" | "message";
  readonly snippet: string | null;
  readonly messageRole: "user" | "assistant" | null;
  readonly messageCreatedAt: string | null;
}
