import { describe, expect, it } from "vitest";

import {
  createTextFlow,
  flowTextChanged,
  flowTimerFired,
  flushFlow,
  isAnimating,
  isFlowComplete,
  isFlowing,
  type TextFlowResult,
  type TextFlowState,
} from "./text-flow";

function feed(
  state: TextFlowState,
  text: string,
  options: { finalized?: boolean; nowMs?: number } = {},
): TextFlowResult {
  return flowTextChanged(state, {
    finalized: options.finalized ?? false,
    nowMs: options.nowMs ?? 0,
    text,
  });
}

/** Runs timers to completion, returning the trace of frontiers. */
function drain(result: TextFlowResult, text: string, startMs: number): TextFlowResult {
  let current = result;
  let nowMs = startMs;
  let guard = 0;
  while (current.timerDelayMs !== null) {
    nowMs += current.timerDelayMs;
    current = flowTimerFired(current.state, { nowMs, text });
    if ((guard += 1) > 10_000) throw new Error("flow never settled");
  }
  return current;
}

describe("text flow", () => {
  it("drains a chunky delta word by word instead of revealing it whole", () => {
    const text = `word ${"lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(8)}`;
    const first = feed(createTextFlow(), text);
    expect(first.state.frontier).toBeLessThan(text.length);

    let current = first;
    let nowMs = 0;
    let previous = current.state.frontier;
    while (current.timerDelayMs !== null) {
      nowMs += current.timerDelayMs;
      current = flowTimerFired(current.state, { nowMs, text });
      expect(current.state.frontier).toBeGreaterThanOrEqual(previous);
      previous = current.state.frontier;
    }
    expect(current.state.frontier).toBe(text.length);
  });

  it("completes once finalized", () => {
    const text = `intro ${"body ".repeat(60)}\n\nclosing words here`;
    const done = drain(feed(createTextFlow(), text, { finalized: true }), text, 0);
    expect(isFlowComplete(done.state, text)).toBe(true);
    expect(isAnimating(done.state, text)).toBe(false);
  });

  it("keeps animating while the stream is open even when caught up", () => {
    const text = "short words";
    const result = feed(createTextFlow(), text);
    expect(result.state.frontier).toBe(text.length);
    expect(isFlowing(result.state, text)).toBe(false);
    expect(isAnimating(result.state, text)).toBe(true);
  });

  it("flushes to the end instantly", () => {
    const text = `long ${"content ".repeat(50)}\n\ntail`;
    const mid = feed(createTextFlow(), text);
    const flushed = flushFlow(mid.state, text);
    expect(flushed.state.frontier).toBe(text.length);
    expect(flushed.timerDelayMs).toBeNull();
    expect(isFlowing(flushed.state, text)).toBe(false);
  });

  it("finishes history revised shorter during the settle grace", () => {
    const initial = feed(createTextFlow(), "Preparing the position", { finalized: true });
    expect(initial.state.settling).toBe(true);
    const revised = feed(initial.state, "Done.", { finalized: true, nowMs: 100 });
    const finished = drain(revised, "Done.", 100);
    expect(isFlowComplete(finished.state, "Done.")).toBe(true);
    expect(finished.timerDelayMs).toBeNull();
  });
});
