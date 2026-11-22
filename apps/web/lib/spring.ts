/**
 * Motion that keeps its momentum. A spring pulls its value toward a target
 * and keeps its speed when the target changes, so nothing it drives ever
 * snaps; one shared frame loop steps every spring on the page.
 */

/** A damped spring: `k` is how hard it pulls toward `target`, `c` how much it drags. */
export class Spring {
  x: number;
  v = 0;
  target: number;
  k: number;
  c: number;

  constructor(x = 0, k = 320, c = 24) {
    this.x = x;
    this.target = x;
    this.k = k;
    this.c = c;
  }

  /** A new place to go, from wherever it is and however fast it's going there. */
  to(target: number, k = this.k, c = this.c): this {
    this.target = target;
    this.k = k;
    this.c = c;
    return this;
  }

  /** A push: speed added to what it has. */
  kick(velocity: number): this {
    this.v += velocity;
    return this;
  }

  /** Straight there, still. */
  snap(x: number): this {
    this.x = x;
    this.target = x;
    this.v = 0;
    return this;
  }

  /** Moves it on by `dt` seconds. Speed is updated first, which keeps a stiff spring stable. */
  step(dt: number): void {
    const pull = -this.k * (this.x - this.target) - this.c * this.v;
    this.v += pull * dt;
    this.x += this.v * dt;
  }

  /** Close enough to its target, and slow enough, to call it there. */
  settled(within = 0.4): boolean {
    return Math.abs(this.x - this.target) < within && Math.abs(this.v) < within * 6;
  }
}

/** The longest step a frame takes, in seconds: after a stall, things carry on rather than leap. */
export const MAX_FRAME_S = 1 / 20;

type Frame = (dt: number) => void;

const subscribers = new Set<Frame>();
let request: number | null = null;
let last = 0;

function tick() {
  // The page's own clock, not the frame's timestamp, so a slowed timeline never slows the physics twice.
  const now = performance.now();
  const dt = Math.min(MAX_FRAME_S, Math.max(0, (now - last) / 1000));
  last = now;
  request = requestAnimationFrame(tick);
  for (const frame of subscribers) frame(dt);
}

function run() {
  if (request !== null || document.hidden) return;
  last = performance.now();
  request = requestAnimationFrame(tick);
}

function halt() {
  if (request !== null) cancelAnimationFrame(request);
  request = null;
}

/** A hidden tab draws nothing, so the loop rests until it's back. */
function onVisibility() {
  if (document.hidden) halt();
  else run();
}

/**
 * Calls `frame` with the seconds since the last frame, every frame, until the
 * returned function is called. The loop runs only while something listens and
 * the tab is showing.
 */
export function onFrame(frame: Frame): () => void {
  subscribers.add(frame);
  if (subscribers.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    run();
  }
  return () => {
    if (!subscribers.delete(frame) || subscribers.size > 0) return;
    document.removeEventListener("visibilitychange", onVisibility);
    halt();
  };
}
