import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_FRAME_S, onFrame, Spring } from "./spring";

/** Steps a spring at 60 frames a second for `seconds`. */
function run(spring: Spring, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) spring.step(1 / 60);
}

describe("Spring", () => {
  it("settles on its target", () => {
    const spring = new Spring(0, 300, 24).to(100);
    run(spring, 2);
    expect(spring.x).toBeCloseTo(100, 1);
    expect(spring.settled()).toBe(true);
  });

  it("overshoots and comes back when it drags little", () => {
    const spring = new Spring(0, 300, 8).to(100);
    let furthest = 0;
    for (let t = 0; t < 2; t += 1 / 60) {
      spring.step(1 / 60);
      furthest = Math.max(furthest, spring.x);
    }
    expect(furthest).toBeGreaterThan(100);
    run(spring, 3);
    expect(spring.x).toBeCloseTo(100, 0);
  });

  it("keeps its speed when its target changes mid-flight", () => {
    const spring = new Spring(0, 300, 24).to(100);
    run(spring, 0.1);
    const speed = spring.v;
    expect(speed).toBeGreaterThan(0);
    // Told to stop where it is, it carries on past before it comes back.
    const from = spring.x;
    spring.to(from);
    expect(spring.v).toBe(speed);
    spring.step(1 / 60);
    expect(spring.x).toBeGreaterThan(from);
    run(spring, 2);
    expect(spring.x).toBeCloseTo(from, 1);
  });

  it("takes a push on top of the speed it has", () => {
    const spring = new Spring(0).kick(50).kick(-20);
    expect(spring.v).toBe(30);
  });

  it("stands still where it's snapped to", () => {
    const spring = new Spring(0).kick(80).to(40);
    spring.snap(10);
    expect(spring).toMatchObject({ x: 10, target: 10, v: 0 });
  });
});

describe("onFrame", () => {
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let hidden: boolean;
  let onVisibility: (() => void) | null;

  /** Runs every frame the loop has asked for, `ms` after the last. */
  function advance(ms: number) {
    now += ms;
    const due = [...frames.values()];
    frames.clear();
    for (const frame of due) frame(now);
  }

  beforeEach(() => {
    frames = new Map();
    now = 1_000;
    hidden = false;
    onVisibility = null;
    let id = 0;
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
      id += 1;
      frames.set(id, frame);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (request: number) => frames.delete(request));
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
      addEventListener: (_: string, listener: () => void) => (onVisibility = listener),
      removeEventListener: () => (onVisibility = null),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("runs only while something listens", () => {
    expect(frames.size).toBe(0);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onFrame(first);
    const stopSecond = onFrame(second);
    expect(frames.size).toBe(1);
    advance(16);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(frames.size).toBe(1);
    stopSecond();
    expect(frames.size).toBe(0);
    expect(onVisibility).toBeNull();
  });

  it("hands each listener the seconds since the last frame, never more than a short step", () => {
    const frame = vi.fn();
    const stop = onFrame(frame);
    advance(16);
    expect(frame).toHaveBeenLastCalledWith(0.016);
    advance(2_000);
    expect(frame).toHaveBeenLastCalledWith(MAX_FRAME_S);
    stop();
  });

  it("rests while the tab is hidden and picks up from the moment it's back", () => {
    const frame = vi.fn();
    const stop = onFrame(frame);
    hidden = true;
    onVisibility?.();
    expect(frames.size).toBe(0);
    now += 60_000;
    hidden = false;
    onVisibility?.();
    advance(16);
    expect(frame).toHaveBeenLastCalledWith(0.016);
    stop();
  });
});
