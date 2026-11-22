/** Backlog (chars) at or below which the frontier snaps with no timer. */
const PASS_THROUGH_CHARS = 24;
/** Delay between drain ticks while the stream is still open. */
const TICK_MS = 44;
/** Delay between drain ticks once the turn has finalized (catch-up). */
const FINALIZED_TICK_MS = 26;
/** Every this-many backlog chars adds one word to a drain tick. */
const DRAIN_CHARS_PER_EXTRA_WORD = 160;
/** Upper bound on words revealed per drain tick. */
const MAX_WORDS_PER_TICK = 8;

/** How long a fully revealed flow keeps animating so tail words finish fading. */
const SETTLE_GRACE_MS = 250;

/** Tolerance for timers firing marginally before their target. */
const TIMER_EPSILON_MS = 5;

export interface TextFlowState {
  /** True after the stream ends; durable history may still revise the text. */
  readonly finalized: boolean;
  /** Chars of the target text currently visible. */
  readonly frontier: number;
  /** Absolute wall-clock ms when the pending timer should fire, if any. */
  readonly timerTargetMs: number | null;
  /** Fully revealed and finalized; animation holds until the grace elapses. */
  readonly settling: boolean;
}

export interface TextFlowResult {
  readonly state: TextFlowState;
  /** ms until `flowTimerFired` should be invoked; null when no timer is needed. */
  readonly timerDelayMs: number | null;
}

export function createTextFlow(): TextFlowState {
  return { finalized: false, frontier: 0, settling: false, timerTargetMs: null };
}

/** Feed the machine the current buffered text; call on every delta. */
export function flowTextChanged(
  state: TextFlowState,
  input: { readonly text: string; readonly finalized: boolean; readonly nowMs: number },
): TextFlowResult {
  return settle({ ...state, finalized: input.finalized }, input.text, input.nowMs);
}

/** Invoke when the previously returned timer delay elapses. */
export function flowTimerFired(
  state: TextFlowState,
  input: { readonly text: string; readonly nowMs: number },
): TextFlowResult {
  if (state.timerTargetMs === null) return { state, timerDelayMs: null };
  if (input.nowMs + TIMER_EPSILON_MS < state.timerTargetMs) {
    // Fired early (stale timer): re-arm for the remaining time.
    return { state, timerDelayMs: state.timerTargetMs - input.nowMs };
  }
  const next: Mutable = { ...state, timerTargetMs: null };
  if (next.settling) {
    next.settling = false;
    // History or resumed text can arrive during grace. Keep draining it
    // instead of leaving an unfinished cursor without a timer.
    if (next.frontier >= input.text.length) return { state: next, timerDelayMs: null };
  }
  return settle(next, input.text, input.nowMs);
}

/** Reveal everything immediately (submit, hidden tab, reduced motion, unmount). */
export function flushFlow(state: TextFlowState, text: string): TextFlowResult {
  return {
    state: { ...state, frontier: text.length, settling: false, timerTargetMs: null },
    timerDelayMs: null,
  };
}

/** True while the visible prefix trails the buffered text (drives "typing…"). */
export function isFlowing(state: TextFlowState, text: string): boolean {
  return state.frontier < text.length;
}

export function isAnimating(state: TextFlowState, text: string): boolean {
  return !state.finalized || state.settling || isFlowing(state, text);
}

/** The flow is done: fully revealed, finalized, grace elapsed. */
export function isFlowComplete(state: TextFlowState, text: string): boolean {
  return state.finalized && !isAnimating(state, text);
}

type Mutable = { -readonly [Key in keyof TextFlowState]: TextFlowState[Key] };

function settle(next: Mutable, text: string, nowMs: number): TextFlowResult {
  if (next.timerTargetMs !== null) return withTimer(next, nowMs);

  const backlog = text.length - next.frontier;
  const wordBudget =
    backlog <= PASS_THROUGH_CHARS
      ? Number.POSITIVE_INFINITY
      : Math.min(MAX_WORDS_PER_TICK, 1 + Math.floor(backlog / DRAIN_CHARS_PER_EXTRA_WORD));
  next.frontier = advanceWords(text, next.frontier, wordBudget);

  if (next.frontier >= text.length) {
    if (next.finalized && !next.settling) {
      next.settling = true;
      next.timerTargetMs = nowMs + SETTLE_GRACE_MS;
    }
    return withTimer(next, nowMs);
  }
  next.timerTargetMs = nowMs + (next.finalized ? FINALIZED_TICK_MS : TICK_MS);
  return withTimer(next, nowMs);
}

/** The frontier after revealing up to `wordBudget` more words, and the whitespace after them. */
function advanceWords(text: string, frontier: number, wordBudget: number): number {
  let at = skipSpace(text, frontier);
  for (let revealed = 0; revealed < wordBudget && at < text.length; revealed += 1) {
    while (at < text.length && !isSpace(text.charCodeAt(at))) at += 1;
    at = skipSpace(text, at);
  }
  return at;
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && isSpace(text.charCodeAt(at))) at += 1;
  return at;
}

function isSpace(code: number): boolean {
  // space, tab, newline, carriage return
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function withTimer(next: Mutable, nowMs: number): TextFlowResult {
  return {
    state: next,
    timerDelayMs: next.timerTargetMs === null ? null : Math.max(0, next.timerTargetMs - nowMs),
  };
}
