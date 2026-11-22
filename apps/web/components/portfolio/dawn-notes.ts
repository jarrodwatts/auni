/**
 * Where the notes written on a Dawn chart go. A note is two lines of text in
 * the sky above the line, beside a hairline rising from its bead. Two notes
 * sit on two rows, so they never touch, and each hairline stays clear of the
 * other note's words. Everything stays inside the chart, phone widths too.
 */

/** A chart narrower than this sets its notes smaller and closer. */
export const COMPACT_WIDTH = 400;

interface Rows {
  /** Each row's top, in pixels from the chart's top. */
  readonly tops: readonly [number, number];
  /** A note's two lines, tall. */
  readonly block: number;
  /** Room kept between the lower note and the line. */
  readonly clear: number;
}

const ROWS: Rows = { tops: [16, 58], block: 31, clear: 14 };
const COMPACT_ROWS: Rows = { tops: [12, 50], block: 29, clear: 12 };

/** From the hairline to its words. */
const GAP = 6;
/** Kept clear of the chart's sides. */
const EDGE = 16;
/** A note squeezed narrower than this says too little to keep. */
const MIN_WIDTH = 72;
/** The widest a note runs before its title trails off. */
const MAX_WIDTH = 220;
const COMPACT_MAX_WIDTH = 160;
/** How close a hairline may pass the other note's words. */
const CLEARANCE = 4;
/** The least two beads with notes stand apart, in pixels. */
const APART = 10;

export function noteRows(compact: boolean): Rows {
  return compact ? COMPACT_ROWS : ROWS;
}

/** The sky a chart keeps clear above its line for this many notes. */
export function noteAir(count: number, compact: boolean): number {
  if (count === 0) return 0;
  const rows = noteRows(compact);
  return rows.tops[Math.min(count, 2) - 1]! + rows.block + rows.clear;
}

export interface NoteSpot {
  /** The bead's place across the chart. */
  readonly x: number;
  /** How wide its words want to be. */
  readonly width: number;
}

export interface PlacedNote {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  /** Which side of its hairline the words sit. */
  readonly side: "right" | "left";
}

interface Option extends PlacedNote {
  /** Lower is better: words to the right of the hairline, and whole. */
  readonly cost: number;
}

function options(spot: NoteSpot, chartWidth: number, compact: boolean): Option[] {
  const wanted = Math.min(spot.width, compact ? COMPACT_MAX_WIDTH : MAX_WIDTH);
  const rooms = [
    { side: "right" as const, room: chartWidth - EDGE - (spot.x + GAP), cost: 0 },
    { side: "left" as const, room: spot.x - GAP - EDGE, cost: 1 },
  ];
  return rooms.flatMap(({ side, room, cost }) => {
    const width = Math.floor(Math.min(wanted, room));
    if (width < Math.min(wanted, MIN_WIDTH)) return [];
    const left = side === "right" ? spot.x + GAP : spot.x - GAP - width;
    return [{ top: 0, left, width, side, cost: cost + (width < wanted ? 2 : 0) }];
  });
}

/** Whether a hairline at x passes through a note's words. */
function crosses(x: number, note: PlacedNote): boolean {
  return x >= note.left - CLEARANCE && x <= note.left + note.width + CLEARANCE;
}

/** A note set on a row, without what it cost. */
function onRow({ left, width, side }: Option, top: number): PlacedNote {
  return { top, left, width, side };
}

/**
 * Each note's place, or null for one there is no room for. The first note
 * is the one kept when only one fits. The earlier bead takes the upper row
 * where it can, so the hairlines never cross.
 */
export function placeNotes(
  spots: readonly NoteSpot[],
  chartWidth: number,
  compact: boolean,
): (PlacedNote | null)[] {
  const { tops } = noteRows(compact);
  const [first, second] = spots;
  if (!first) return [];
  const alone = options(first, chartWidth, compact)[0];
  const lone = alone ? onRow(alone, tops[0]) : null;
  // Hairlines this close read as one line.
  if (!second || Math.abs(first.x - second.x) < APART) return second ? [lone, null] : [lone];

  const firstIsEarlier = first.x <= second.x;
  let best: { readonly notes: [PlacedNote, PlacedNote]; readonly cost: number } | null = null;
  for (const firstUp of [true, false]) {
    for (const a of options(first, chartWidth, compact)) {
      for (const b of options(second, chartWidth, compact)) {
        const notes: [PlacedNote, PlacedNote] = firstUp
          ? [onRow(a, tops[0]), onRow(b, tops[1])]
          : [onRow(a, tops[1]), onRow(b, tops[0])];
        // The upper note's hairline rises through the lower row; the lower one's stops beneath the upper.
        const [upperX, lower] = firstUp ? [first.x, notes[1]] : [second.x, notes[0]];
        if (crosses(upperX, lower)) continue;
        const cost = a.cost + b.cost + (firstUp === firstIsEarlier ? 0 : 0.5);
        if (!best || cost < best.cost) best = { notes, cost };
      }
    }
  }
  return best ? best.notes : [lone, null];
}
