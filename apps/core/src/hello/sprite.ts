// Auni as a terminal sprite: the mascot's own body and cap (apps/web/components/brand/mascot-art.tsx),
// sampled down to 18 by 16 square pixels and kept to its own colours, with its face drawn on top
// pixel by pixel, so it blinks, looks, smiles and frowns like the real one.

/** The body's colours, darkest first, as the mascot's gradients sample them. */
const PALETTE: Readonly<Record<string, string>> = {
  a: "6394fe",
  b: "7f9afc",
  c: "73a4ff",
  d: "7eb1ff",
  e: "90a8ff",
  f: "88baff",
  g: "9ea8ff",
  h: "90c3ff",
  i: "9ccbff",
  j: "afd1fe",
  k: "d0d7f7",
  l: "ecdfee",
  m: "f6e2e5",
  // The cap, deepest first: a violet curl over the top that hangs down the right side.
  n: "6a5cf0",
  o: "8578f7",
  p: "a59cfb",
};

// prettier-ignore
const BODY = [
  ".......nnnnoo.....",
  ".....aannoooopp...",
  "....aaaccnnoooppp.",
  "...aaaccdffnnoopp.",
  "...aaccddfhhiinoop",
  "..aaaccdfhhiiijnoo",
  "..aaccdffhiijjjj..",
  ".aaccddfhiijjjkkk.",
  ".aaccdfhhijjkkkkk.",
  ".accdffhijjkkllll.",
  ".ccddfhhijkklllll.",
  ".ccdfhhiijkkllmmm.",
  ".cdffhiijjkklmmmm.",
  ".ddfhiiijjkklmmmm.",
  "..fhhiiijjkkllmm..",
  "....iiiijjjkkll...",
] as const;

export const SPRITE_W = BODY[0].length;
export const SPRITE_H = BODY.length;

/** The face's ink, as the mascot's. */
export const INK = "101e38";

/**
 * The faces Auni pulls here: eyes open, shut (asleep, or a blink), smiling shut ("joy"), and
 * worried, with its brows up in the middle. `look` moves the eyes a pixel either way.
 */
export type Face = "open" | "shut" | "joy" | "worry";

/** Where the eyes' tops sit when they look straight ahead: the left one a little lower, as drawn. */
const LEFT = { x: 6, y: 7 } as const;
const RIGHT = { x: 11, y: 6 } as const;

/** An eye, three pixels tall, as the mascot's tall ovals are. */
const EYE = (x: number, y: number) =>
  [
    [x, y],
    [x, y + 1],
    [x, y + 2],
  ] as const;

/** The pixels of a face, relative to the sprite's top left. */
export function facePixels(
  face: Face,
  look: -1 | 0 | 1 = 0,
): readonly (readonly [number, number])[] {
  const [left, right] = [LEFT, RIGHT].map(({ x, y }) => ({ x: x + look, y })) as [
    { x: number; y: number },
    { x: number; y: number },
  ];
  // The mascot's one brow, arched over its left eye.
  const brow = [
    [left.x - 1, left.y - 2],
    [left.x, left.y - 3],
    [left.x + 1, left.y - 3],
  ] as const;
  switch (face) {
    case "open":
      return [...EYE(left.x, left.y), ...EYE(right.x, right.y), ...brow];
    case "shut":
      return [left, right].flatMap(({ x, y }) => [
        [x - 1, y + 2] as const,
        [x, y + 2] as const,
        [x + 1, y + 2] as const,
      ]);
    case "joy":
      return [left, right].flatMap(({ x, y }) => [
        [x - 1, y + 2] as const,
        [x, y + 1] as const,
        [x + 1, y + 2] as const,
      ]);
    case "worry": {
      // Eyes open under both brows raised at their inner ends, and a small frown under them.
      const mouth = Math.round((left.x + right.x) / 2);
      return [
        ...EYE(left.x, left.y),
        ...EYE(right.x, right.y),
        [left.x - 2, left.y - 2],
        [left.x - 1, left.y - 2],
        [left.x, left.y - 3],
        [right.x, right.y - 3],
        [right.x + 1, right.y - 2],
        [right.x + 2, right.y - 2],
        [mouth - 1, left.y + 5],
        [mouth, left.y + 4],
        [mouth + 1, left.y + 5],
      ];
    }
  }
}

/** One pixel's colour as "rrggbb", or null where Auni isn't. */
export type Pixel = string | null;

/**
 * Auni's pixels in a pose: its face, and squashed (`squash` > 0, wider and shorter, as it lands
 * or crouches) or stretched (< 0, as it leaps), from its feet. Rows run top to bottom.
 */
export function spritePixels({
  face,
  look = 0,
  squash = 0,
}: {
  readonly face: Face;
  readonly look?: -1 | 0 | 1;
  readonly squash?: number;
}): Pixel[][] {
  const rows: Pixel[][] = BODY.map((row) =>
    [...row].map((letter) => (letter === "." ? null : PALETTE[letter]!)),
  );
  for (const [x, y] of facePixels(face, look)) if (rows[y]?.[x]) rows[y]![x] = INK;
  if (squash === 0) return rows;
  // Squashed, Auni loses rows from the top and keeps its width; stretched, it gains them.
  const height = Math.max(4, Math.round(SPRITE_H * (1 - squash * 0.25)));
  return Array.from({ length: height }, (_, y) => {
    const from = Math.min(SPRITE_H - 1, Math.floor((y * SPRITE_H) / height));
    return [...rows[from]!];
  });
}
