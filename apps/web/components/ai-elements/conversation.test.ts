import { expect, it } from "vitest";

import { followTo } from "./conversation";

/** Something `top` to `bottom` px down the transcript's content, which starts 100px down the window. */
const at = (top: number, bottom = top + 50) => ({
  getBoundingClientRect: () => ({ top: 100 + top, bottom: 100 + bottom }),
});

/**
 * A transcript whose newest turn, read from its start, begins `start` px down its content, and
 * whose owner's newest message is `own`.
 */
const transcript = (
  start: number | null,
  windowHeight = 650,
  own: readonly [number, number] | null = null,
) => {
  const turn = start === null ? null : at(start);
  return {
    contentElement: {
      querySelector: () => turn,
      querySelectorAll: () => (own ? [at(0, 10), at(...own)] : []),
      getBoundingClientRect: () => ({ top: 100 }),
    },
    scrollElement: { clientHeight: windowHeight },
  } as unknown as Parameters<typeof followTo>[1];
};

it("follows to the end when no turn is to be read from its start", () => {
  expect(followTo(5_000, transcript(null))).toBe(5_000);
});

// On a phone a card that came below a turn's words stayed under the window's foot: the follow
// stopped with 30% of the window kept for what came before (2026-11-16).
it("follows a turn read from its start until its beginning nears the window's top", () => {
  expect(followTo(5_000, transcript(4_000))).toBe(4_000 - 24);
  // A turn whose end is in view before its beginning reaches the top is followed to its end.
  expect(followTo(3_900, transcript(4_000))).toBe(3_900);
});

// When the first card landed, the chat followed it 32px down, leaving the owner's take a grey
// sliver under the header (2026-11-17).
it("keeps the owner's newest message in view whole, or follows past all of it", () => {
  // The answer's end would cut their message: the follow stops with it all in view.
  expect(followTo(112, transcript(null, 650, [80, 130]))).toBe(80 - 24);
  expect(followTo(60, transcript(null, 650, [80, 130]))).toBe(80 - 24);
  // Short of it, or past all of it, the end it is.
  expect(followTo(40, transcript(null, 650, [80, 130]))).toBe(40);
  expect(followTo(140, transcript(null, 650, [80, 130]))).toBe(140);
});
