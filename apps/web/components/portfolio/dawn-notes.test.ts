import { describe, expect, it } from "vitest";

import { noteAir, noteRows, placeNotes, type NoteSpot, type PlacedNote } from "./dawn-notes";

/** Every note inside the chart, on its own row, and no hairline through another note's words. */
function expectClear(
  spots: readonly NoteSpot[],
  placed: readonly (PlacedNote | null)[],
  width: number,
) {
  const shown = placed.flatMap((note, index) => (note ? [{ note, x: spots[index]!.x }] : []));
  for (const { note } of shown) {
    expect(note.left).toBeGreaterThanOrEqual(16);
    expect(note.left + note.width).toBeLessThanOrEqual(width - 16);
  }
  if (shown.length < 2) return;
  const [a, b] = shown as [(typeof shown)[number], (typeof shown)[number]];
  expect(a.note.top).not.toBe(b.note.top);
  const [upper, lower] = a.note.top < b.note.top ? [a, b] : [b, a];
  const passes =
    upper.x >= lower.note.left - 4 && upper.x <= lower.note.left + lower.note.width + 4;
  expect(passes).toBe(false);
}

describe("placeNotes", () => {
  it("writes two notes right of their hairlines, the earlier one on top", () => {
    const spots = [
      { x: 157, width: 180 },
      { x: 229, width: 170 },
    ];
    const placed = placeNotes(spots, 560, false);

    expect(placed).toEqual([
      { top: noteRows(false).tops[0], left: 163, width: 180, side: "right" },
      { top: noteRows(false).tops[1], left: 235, width: 170, side: "right" },
    ]);
    expectClear(spots, placed, 560);
  });

  it("turns a note near the right edge to the left of its hairline", () => {
    const [placed] = placeNotes([{ x: 320, width: 140 }], 340, true);

    expect(placed).toMatchObject({ side: "left", left: 174, width: 140 });
  });

  it("swaps the rows when the later note's words would sit across the earlier hairline", () => {
    const spots = [
      { x: 200, width: 150 },
      { x: 320, width: 150 },
    ];
    const placed = placeNotes(spots, 340, true);

    expect(placed.every(Boolean)).toBe(true);
    expect(placed[1]!.top).toBeLessThan(placed[0]!.top);
    expectClear(spots, placed, 340);
  });

  it("caps a long title on a phone so it trails off instead of crossing the card", () => {
    const spots = [{ x: 40, width: 400 }];
    const [placed] = placeNotes(spots, 340, true);

    expect(placed!.width).toBeLessThanOrEqual(160);
    expectClear(spots, [placed!], 340);
  });

  it("keeps only the first note when the beads sit almost on each other", () => {
    expect(
      placeNotes(
        [
          { x: 120, width: 100 },
          { x: 124, width: 100 },
        ],
        560,
        false,
      ),
    ).toEqual([expect.objectContaining({ left: 126 }), null]);
  });
});

describe("noteAir", () => {
  it("keeps the line under every row of notes", () => {
    const rows = noteRows(false);
    expect(noteAir(0, false)).toBe(0);
    expect(noteAir(1, false)).toBeGreaterThan(rows.tops[0] + rows.block);
    expect(noteAir(2, false)).toBeGreaterThan(rows.tops[1] + rows.block);
  });
});
