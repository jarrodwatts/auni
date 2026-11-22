import { describe, expect, it } from "vitest";

import { renderScene, SCENE_ROWS, SCENE_WIDTH, standingX, type SceneState } from "./scene.ts";
import { facePixels, spritePixels, SPRITE_H, SPRITE_W } from "./sprite.ts";

const stones = (brain: SceneState["stones"][number]["state"]): SceneState["stones"] => [
  { label: "memory", state: "ready" },
  { label: "your page", state: "ready" },
  { label: "brain", state: brain },
];

const at = (over: Partial<SceneState> = {}): SceneState => ({
  stones: stones("working"),
  auni: { x: standingX(1), lift: 0, face: "open", look: 0, squash: 0 },
  bubble: { text: "Looking for my brain", shown: 20 },
  notes: [],
  tick: 0,
  ...over,
});

const ESC = String.fromCharCode(27);

// A terminal's escapes, so a test reads what a person sees: colours dropped, a jump as the spaces it skips.
const plain = (line: string) =>
  line
    .replaceAll(new RegExp(`${ESC}\\[[\\d;]*m`, "gu"), "")
    .replaceAll(new RegExp(`${ESC}\\[(\\d+)C`, "gu"), (_, n: string) => " ".repeat(Number(n)));

describe("the terminal's scene", () => {
  it("is one block no wider than the scene every frame, notes under it", () => {
    const lines = renderScene(at({ notes: ["Auni is open in your browser"] }), "truecolor");
    expect(lines).toHaveLength(SCENE_ROWS + 1);
    for (const line of lines.slice(0, SCENE_ROWS))
      expect([...plain(line)].length).toBeLessThanOrEqual(SCENE_WIDTH);
    expect(plain(lines.at(-1)!)).toBe("  Auni is open in your browser");
  });

  it("ticks each stone that's ready, and dashes the brain it couldn't find", () => {
    const found = renderScene(at({ stones: stones("ready") }), "none")
      .map(plain)
      .join("\n");
    expect(found).toContain("✓ memory");
    expect(found).toContain("✓ brain");
    const missing = renderScene(at({ stones: stones("missing") }), "none")
      .map(plain)
      .join("\n");
    expect(missing).toContain("? brain");
    expect(missing).toContain("┆");
  });

  it("says what Auni says as it types, in a box that keeps its width", () => {
    const typed = (shown: number) =>
      renderScene(at({ bubble: { text: "Looking for my brain", shown } }), "none").slice(0, 3);
    expect(plain(typed(7)[1]!)).toContain("Looking");
    expect(plain(typed(7)[1]!)).not.toContain("brain");
    expect(plain(typed(7)[0]!).trim()).toBe(plain(typed(20)[0]!).trim());
  });

  it("draws nothing but characters without colour, as NO_COLOR asks", () => {
    const lines = renderScene(at(), "none");
    expect(lines.join("")).not.toMatch(new RegExp(`${ESC}\\[[\\d;]*m`, "u"));
    // Auni is there, as its silhouette.
    expect(lines.join("")).toMatch(/[▀▄█]/u);
  });

  it("colours by xterm's palette where the terminal has no true colour", () => {
    const lines = renderScene(at(), "256").join("");
    expect(lines).toContain("38;5;");
    expect(lines).not.toContain("38;2;");
  });

  // A bubble that blanked its whole rows cut a bar across Auni's face as it rose past them.
  it("covers only its own box with what Auni says, never the rest of Auni", () => {
    const high = at({
      // Lifted so its widest rows are where the bubble is.
      auni: { x: standingX(1), lift: 20, face: "open", look: 0, squash: 0 },
      bubble: { text: "Hi", shown: 2 },
    });
    const top = renderScene(high, "none").slice(0, 3).map(plain);
    // The box is twelve wide over Auni's eighteen, so Auni shows on both sides of it.
    for (const row of top) expect(row).toMatch(/[▀▄█] *[╭│╰].*[╮│╯] *[▀▄█]/u);
  });

  it("leaves the sky empty once Auni has leapt into the browser", () => {
    const sky = renderScene(at({ auni: null }), "none").slice(0, 14);
    expect(sky.map(plain).join("").trim()).toBe("");
  });
});

describe("Auni's sprite", () => {
  it("is the mascot's size, its face drawn inside it", () => {
    const pixels = spritePixels({ face: "open" });
    expect(pixels).toHaveLength(SPRITE_H);
    for (const row of pixels) expect(row).toHaveLength(SPRITE_W);
    for (const face of ["open", "shut", "joy", "worry"] as const)
      for (const [x, y] of facePixels(face)) expect(spritePixels({ face })[y]![x]).not.toBeNull();
  });

  it("squashes shorter as it lands and stretches taller as it leaps", () => {
    expect(spritePixels({ face: "open", squash: 0.4 }).length).toBeLessThan(SPRITE_H);
    expect(spritePixels({ face: "open", squash: -0.3 }).length).toBeGreaterThan(SPRITE_H);
  });
});
