/**
 * The app's motion, as values the Web Animations API takes. The same values
 * are CSS variables in app/tokens.css; the two must match, and a test reads
 * both to keep them so.
 */

/** How long things take, in ms, named by what they do. */
export const durations = {
  /** A glyph or colour flipping, too small to follow. */
  instant: 120,
  /** Words leaving. */
  fast: 160,
  /** Something going away for good. */
  exit: 180,
  /** Words or a glyph arriving. */
  standard: 240,
  /** Something the eye should notice settle. */
  considered: 480,
  /** A box easing to its new size. */
  resize: 420,
} as const;

/** Curves, named by role. Each one is also `--motion-<name>` in CSS. */
export const easings = {
  /** The default for anything the eye tracks: arrives early, eases to rest. */
  settle: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** Settle's longer, softer form, for whole surfaces and new words. */
  drift: "cubic-bezier(0.16, 1, 0.3, 1)",
  /** Speeds up as it goes: for things leaving. */
  exit: "cubic-bezier(0.7, 0, 0.84, 0)",
  /** Even in and out: for things moving from one place to another. */
  glide: "cubic-bezier(0.45, 0, 0.25, 1)",
} as const;

/** How soft things look while they move, in px. */
export const blurs = {
  subtle: 2,
  soft: 4,
} as const;

/** Whether the person asked for less motion. False on the server, where nothing moves. */
export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Stops an animation where it has got to, so the next one on that element
 * starts from there rather than jumping back to its resting look.
 */
export function hold(animation: Animation | null): void {
  if (animation?.playState !== "running") return;
  try {
    animation.commitStyles();
  } catch {
    // An element that isn't drawn has nowhere to hold; it simply stops.
  }
  animation.cancel();
}
