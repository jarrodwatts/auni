import { INK, SPRITE_W, spritePixels, type Face, type Pixel } from "./sprite.ts";

// One frame of the terminal moment as `auni` starts (stage.ts plays it): Auni on three stones,
// one for each thing it really starts, in the order they come: its memory (the database), its
// brain (your AI), your page (the web app). A speech bubble over Auni, and what to know under
// them. The sky is as wide as the terminal, so Auni leaps off its real right edge. Pure, so a
// test can read any frame.
//
//      ╭──────────────────────────╮
//      │ See you in your browser! │
//      ╰─────────────▾────────────╯
//                    ▄██▀▀▄
//                   ████████        Auni, two pixels a character, with half blocks
//   ╭───────────────╮   ╭───────────────╮   ╭───────────────╮
//   │   ✓ memory    │   │ ✓ Claude Code │   │  ✓ your page  │
//   ╰───────────────╯   ╰───────────────╯   ╰───────────────╯

type StoneState = "waiting" | "working" | "ready" | "missing";

export interface SceneState {
  readonly stones: readonly { readonly label: string; readonly state: StoneState }[];
  /** Null once Auni has leapt out of the terminal. */
  readonly auni: {
    /** The column its left edge is at. */
    readonly x: number;
    /** How many pixels above its stone it is. */
    readonly lift: number;
    readonly face: Face;
    readonly look: -1 | 0 | 1;
    readonly squash: number;
  } | null;
  /** What Auni says, and how many of its characters have typed in so far; null when it says nothing. */
  readonly bubble: { readonly text: string; readonly shown: number } | null;
  /** Lines under the stones: where Auni is, what to run. */
  readonly notes: readonly string[];
  /** The frame a working stone's spinner is on. */
  readonly tick: number;
}

export type ColorMode = "truecolor" | "256" | "none";

const STONE_W = 17;
const GAP = 3;
const LEFT = 2;
/** The rows Auni moves in, bubble included: it stands on the last. */
export const SKY_ROWS = 14;
const BUBBLE_ROWS = 3;
export const SCENE_WIDTH = LEFT + 3 * STONE_W + 2 * GAP + 2;
/** Rows the scene takes, notes aside: the sky, the stones, and a blank row under them. */
export const SCENE_ROWS = SKY_ROWS + 3 + 1;

/** The column Auni stands at on stone `index`, its middle over the stone's. */
export function standingX(index: number): number {
  return LEFT + index * (STONE_W + GAP) + Math.floor((STONE_W - SPRITE_W) / 2);
}

// Quarter blocks, which every terminal font draws, turning like the pixels Auni is made of.
const SPINNER = "▖▘▝▗";

const BLUE = "6394fe";
const AMBER = "e8a33d";
const DIM = "8a93a6";

interface Cell {
  ch: string;
  fg?: string | undefined;
  bg?: string | undefined;
  bold?: boolean | undefined;
}

/**
 * The scene as lines to print, each ending in a reset where it has colour. `columns` is how wide
 * the sky is: the terminal's, so Auni can leap off its edge, and never less than the stones.
 */
export function renderScene(state: SceneState, color: ColorMode, columns = SCENE_WIDTH): string[] {
  const width = Math.max(columns, SCENE_WIDTH);
  const sky = drawSky(state, width, color);
  // The bubble covers only its own box, so Auni passing beside or under it stays whole.
  const bubble = state.bubble === null || state.auni === null ? null : bubbleCells(state, width);
  if (bubble)
    for (let row = 0; row < BUBBLE_ROWS; row++)
      for (let column = bubble.left; column < bubble.right; column++)
        sky[row]![column] = bubble.rows[row]![column]!;
  const rows = [...sky, ...drawStones(state, width), blank(width)];
  const notes = state.notes.map((line, index) =>
    text(`  ${line}`, index === 0 ? undefined : DIM, index === 0),
  );
  return [...rows, ...notes].map((cells) => serialize(cells, color));
}

function blank(width: number): Cell[] {
  return Array.from({ length: width }, () => ({ ch: " " }));
}

function text(line: string, fg?: string, bold?: boolean): Cell[] {
  return [...line].map((ch) => ({ ch, fg, bold }));
}

/** Auni on its pixels, two to a character. */
function drawSky(state: SceneState, width: number, color: ColorMode): Cell[][] {
  const height = SKY_ROWS * 2;
  const pixels: Pixel[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => null),
  );
  if (state.auni) {
    const { x, lift, face, look, squash } = state.auni;
    const sprite = spritePixels({ face, look, squash });
    const top = height - sprite.length - Math.round(lift);
    const left = Math.round(x) - Math.max(0, Math.round((sprite[0]!.length - SPRITE_W) / 2));
    sprite.forEach((row, dy) =>
      row.forEach((pixel, dx) => {
        const py = top + dy;
        const px = left + dx;
        if (pixel && py >= 0 && py < height && px >= 0 && px < width) pixels[py]![px] = pixel;
      }),
    );
  }
  const rows: Cell[][] = [];
  for (let row = 0; row < SKY_ROWS; row++) {
    const upper = pixels[row * 2]!;
    const lower = pixels[row * 2 + 1]!;
    rows.push(upper.map((top, column) => halfBlock(top, lower[column]!, color)));
  }
  return rows;
}

/**
 * Two pixels in one character: the upper as the glyph's colour over the lower as its background.
 * Without colour, Auni is its silhouette, its eyes holes in it.
 */
function halfBlock(top: Pixel, bottom: Pixel, color: ColorMode): Cell {
  if (color === "none") {
    const up = top !== null && top !== INK;
    const down = bottom !== null && bottom !== INK;
    return { ch: up && down ? "█" : up ? "▀" : down ? "▄" : " " };
  }
  // One colour fills the whole cell as its background alone.
  if (top && top === bottom) return { ch: " ", bg: top };
  if (top && bottom) return { ch: "▀", fg: top, bg: bottom };
  if (top) return { ch: "▀", fg: top };
  if (bottom) return { ch: "▄", fg: bottom };
  return { ch: " " };
}

/** What Auni says, in a rounded box over its head, its tail pointing down at it. */
function bubbleCells(
  state: SceneState,
  width: number,
): { readonly rows: Cell[][]; readonly left: number; readonly right: number } {
  const { text: said, shown } = state.bubble!;
  // The box keeps its full width as the words type into it.
  const inner = Math.min(width - 4, Math.max(said.length, 8));
  const boxW = inner + 4;
  const middle = state.auni!.x + SPRITE_W / 2;
  const left = Math.max(0, Math.min(width - boxW, Math.round(middle - boxW / 2)));
  const tail = Math.max(left + 2, Math.min(left + boxW - 3, Math.round(middle)));
  const rows = [blank(width), blank(width), blank(width)];
  const put = (row: number, column: number, ch: string, fg?: string, bold?: boolean) => {
    rows[row]![column] = { ch, fg, bold };
  };
  put(0, left, "╭", DIM);
  put(0, left + boxW - 1, "╮", DIM);
  put(2, left, "╰", DIM);
  put(2, left + boxW - 1, "╯", DIM);
  for (let column = left + 1; column < left + boxW - 1; column++) {
    put(0, column, "─", DIM);
    put(2, column, column === tail ? "▾" : "─", DIM);
  }
  put(1, left, "│", DIM);
  put(1, left + boxW - 1, "│", DIM);
  [...said.slice(0, Math.min(inner, shown))].forEach((ch, index) =>
    put(1, left + 2 + index, ch, undefined, true),
  );
  return { rows, left, right: left + boxW };
}

/** The three stones: waiting dim, working with a spinner, ready ticked in Auni's blue, missing dashed. */
function drawStones(state: SceneState, width: number): Cell[][] {
  const rows = [blank(width), blank(width), blank(width)];
  state.stones.forEach((stone, index) => {
    const left = LEFT + index * (STONE_W + GAP);
    const dashed = stone.state === "missing";
    const edge = stone.state === "ready" ? BLUE : stone.state === "missing" ? AMBER : DIM;
    const [h, v] = dashed ? ["┄", "┆"] : ["─", "│"];
    const mark =
      stone.state === "ready"
        ? "✓"
        : stone.state === "missing"
          ? "?"
          : stone.state === "working"
            ? SPINNER[state.tick % SPINNER.length]!
            : " ";
    // A name too long for its stone is cut to fit.
    const label = `${mark} ${stone.label}`.slice(0, STONE_W - 2);
    const pad = STONE_W - 2 - label.length;
    const inside = `${" ".repeat(Math.floor(pad / 2))}${label}${" ".repeat(Math.ceil(pad / 2))}`;
    const top = `╭${h.repeat(STONE_W - 2)}╮`;
    const bottom = `╰${h.repeat(STONE_W - 2)}╯`;
    [...top].forEach((ch, i) => (rows[0]![left + i] = { ch, fg: edge }));
    [...bottom].forEach((ch, i) => (rows[2]![left + i] = { ch, fg: edge }));
    rows[1]![left] = { ch: v, fg: edge };
    rows[1]![left + STONE_W - 1] = { ch: v, fg: edge };
    const markAt = inside.indexOf(mark);
    [...inside].forEach((ch, i) => {
      const isMark = i === markAt && mark !== " ";
      rows[1]![left + 1 + i] = {
        ch,
        fg: isMark ? edge : stone.state === "waiting" ? DIM : undefined,
        bold: stone.state === "ready" && !isMark,
      };
    });
  });
  return rows;
}

const ESC = "\u001B[";

/**
 * The cells as one line, drawn over a row the caller has cleared: a style is set only where it
 * changes, a run of empty cells is skipped over rather than written, and it ends reset. Kept
 * small, so a frame fits in one write to the terminal.
 */
function serialize(cells: readonly Cell[], color: ColorMode): string {
  // Empty cells at the end of the line are the cleared row already.
  let end = cells.length;
  while (end > 0 && isEmpty(cells[end - 1]!)) end--;
  let out = "";
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  for (let index = 0; index < end; index++) {
    let cell = cells[index]!;
    // Two colours in one cell can be drawn either way up: the way that keeps a colour already set.
    if (cell.ch === "▀" && cell.fg && cell.bg && (cell.bg === fg || cell.fg === bg))
      cell = { ...cell, ch: "▄", fg: cell.bg, bg: cell.fg };
    if (isEmpty(cell)) {
      let run = 1;
      while (isEmpty(cells[index + run]!)) run++;
      // A background still set would paint what it skips; otherwise a long run is a jump.
      if (run >= 4 && bg === undefined) {
        out += `${ESC}${run}C`;
        index += run - 1;
        continue;
      }
    }
    if (color !== "none") {
      const codes: string[] = [];
      // An empty cell shows no colour of its own, so whatever is set may stay.
      const shows = !isEmpty(cell);
      if (shows && Boolean(cell.bold) !== bold) {
        bold = Boolean(cell.bold);
        codes.push(bold ? "1" : "22");
      }
      if (shows && cell.fg !== fg) {
        fg = cell.fg;
        codes.push(fg ? fgCode(fg, color) : "39");
      }
      if (cell.bg !== bg) {
        bg = cell.bg;
        codes.push(bg ? bgCode(bg, color) : "49");
      }
      if (codes.length > 0) out += `${ESC}${codes.join(";")}m`;
    }
    out += cell.ch;
  }
  return fg || bg || bold ? `${out}${ESC}0m` : out;
}

const isEmpty = (cell: Cell) => cell.ch === " " && !cell.bg;

function rgb(hex: string): [number, number, number] {
  return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** The nearest of xterm's 216 colours. */
function cube(hex: string): number {
  const [r, g, b] = rgb(hex).map((value) =>
    value < 48 ? 0 : value < 115 ? 1 : Math.round((value - 35) / 40),
  );
  return 16 + 36 * r! + 6 * g! + b!;
}

function fgCode(hex: string, color: ColorMode): string {
  return color === "truecolor" ? `38;2;${rgb(hex).join(";")}` : `38;5;${cube(hex)}`;
}

function bgCode(hex: string, color: ColorMode): string {
  return color === "truecolor" ? `48;2;${rgb(hex).join(";")}` : `48;5;${cube(hex)}`;
}
