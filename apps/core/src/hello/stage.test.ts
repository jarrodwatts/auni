import { describe, expect, it } from "vitest";

import { SCENE_WIDTH, standingX } from "./scene.ts";
import { BRAIN_WAIT_MS, SIGN_IN_THERE, Stage, type StageEvent, type StageSignal } from "./stage.ts";

const ESC = String.fromCharCode(27);

/** The column of the last of Auni's pixels on a line a frame writes, as a terminal shows it. */
const lastPixel = (line: string) =>
  line
    .replaceAll(new RegExp(`${ESC}\\[(\\d+)C`, "gu"), (_, n: string) => " ".repeat(Number(n)))
    .replaceAll(new RegExp(`${ESC}\\[[\\d;?]*[A-Za-z]`, "gu"), "")
    .search(/[▀▄█][^▀▄█]*$/u);

const FOUND = { name: "Claude Code", line: "Auni thinks with Claude Code, on your login." };
const MISSING = { name: null, line: "Auni has nothing to think with yet." };
const COLUMNS = 120;

/** A stage on a clock of its own, played a frame at a time, keeping what each frame showed. */
function play() {
  let now = 0;
  const frames: string[] = [];
  const signals: { readonly signal: StageSignal; readonly at: number }[] = [];
  const stage = new Stage({
    color: "none",
    columns: COLUMNS,
    now,
    write: (frame) => frames.push(frame),
    signal: (signal) => signals.push({ signal, at: now }),
  });
  const views: (typeof stage.view)[] = [];
  return {
    stage,
    frames,
    signals,
    views,
    get now() {
      return now;
    },
    hear: (event: StageEvent) => stage.hear(event, now),
    /** Plays `ms` of the scene, a frame every 33ms. */
    run(ms: number) {
      for (const end = now + ms; now < end;) {
        now += 33;
        stage.tick(now);
        views.push(stage.view);
      }
    },
    /** Plays until Auni has leapt off the terminal, and says when it went. */
    leapt() {
      this.until(() => stage.view.auni === null);
      return now;
    },
    /** Plays until `done`, or fails after `limit`. */
    until(done: () => boolean, limit = 20_000) {
      const end = now + limit;
      while (!done()) {
        if (now > end) throw new Error("the scene never got there");
        this.run(33);
      }
    },
  };
}

/** Each event at its moment: memory at once, the brain a moment later, then the page. */
function upToThePage(scene: ReturnType<typeof play>, brain: typeof FOUND | typeof MISSING) {
  scene.hear({ kind: "memory" });
  scene.hear({ kind: "firstRun", ahead: true });
  scene.run(300);
  scene.hear({ kind: "brain", found: brain });
  scene.run(400);
  scene.hear({ kind: "page" });
}

describe("the terminal's Auni", () => {
  it("never plays a step before it happens: it waits on its memory stone, blinking", () => {
    const scene = play();
    scene.run(4_000);
    expect(scene.stage.view.step).toBe("waking");
    expect(scene.stage.view.auni?.x).toBe(standingX(0));
    expect(scene.stage.view.said).toBe("Starting Auni");
    expect(scene.views.some((view) => view.auni?.face === "shut")).toBe(true);
    expect(scene.signals).toEqual([]);
  });

  it("hops memory, brain, then page, and leaps only once the browser is about to open", () => {
    const scene = play();
    upToThePage(scene, FOUND);
    scene.run(4_000);
    // On the page's stone, ready, and still here: nothing has asked it to go.
    expect(scene.stage.view.auni?.x).toBe(standingX(2));
    expect(scene.stage.view.stones.map(({ label, state }) => `${state} ${label}`)).toEqual([
      "ready Memory",
      "ready Claude Code",
      "ready Web app",
    ]);
    expect(scene.signals).toEqual([]);

    const asked = scene.now;
    scene.hear({ kind: "leave" });
    // Its goodbye, then the leap: about as long as the browser takes to come up.
    expect(scene.leapt() - asked).toBeLessThan(1_500);
    expect(scene.views.some((view) => view.said === "See you in your browser!")).toBe(true);
  });

  it("says its goodbye whole soon after the browser starts to open, as it hops onto its page", () => {
    const scene = play();
    scene.hear({ kind: "memory" });
    scene.hear({ kind: "firstRun", ahead: true });
    scene.run(300);
    scene.hear({ kind: "brain", found: FOUND });
    // The page comes up, and the browser starts to open on it, as Auni hops onto the brain's stone.
    scene.until(() => scene.stage.view.said === "Your AI is ready");
    scene.run(300);
    scene.hear({ kind: "page" });
    const asked = scene.now;
    scene.hear({ kind: "leave" });
    let whole: number | null = null;
    scene.until(() => {
      if (whole === null && scene.frames.at(-1)?.includes("See you in your browser!"))
        whole = scene.now;
      return scene.stage.view.auni === null;
    });
    // Whole within the second a browser takes to come up, and with no "page is ready" before it.
    expect(whole).not.toBeNull();
    expect(whole! - asked).toBeLessThan(1_000);
    expect(scene.views.some((view) => view.said === "Web app ready")).toBe(false);
  });

  it("leaps off the terminal's own right edge, not the stones'", () => {
    const scene = play();
    upToThePage(scene, FOUND);
    scene.hear({ kind: "leave" });
    scene.leapt();
    const furthest = Math.max(...scene.views.map((view) => view.auni?.x ?? 0));
    expect(furthest).toBeGreaterThan(COLUMNS);
    // Frames mid-leap draw Auni well past where the stones end.
    const reach = Math.max(...scene.frames.flatMap((frame) => frame.split("\n").map(lastPixel)));
    expect(reach).toBeGreaterThan(SCENE_WIDTH + 30);
    expect(reach).toBeLessThan(COLUMNS);
  });

  it("folds the empty sky away a row at a time, then leaves what to know", () => {
    const scene = play();
    upToThePage(scene, FOUND);
    scene.hear({ kind: "leave" });
    scene.leapt();
    scene.hear({ kind: "say", line: "\nAuni is open in your browser, at http://localhost:3000" });
    const before = scene.frames.length;
    scene.hear({ kind: "up", opened: true });
    scene.until(() => scene.signals.some(({ signal }) => signal === "ended"));
    // Each frame of the fold clears just the one row it took off the bottom.
    const fold = scene.frames.slice(before, -1);
    expect(fold.length).toBeGreaterThanOrEqual(10);
    expect(scene.stage.view.notes).toEqual([
      "Auni is open in your browser, at http://localhost:3000",
      FOUND.line,
    ]);
  });

  it("frowns at the empty stone with no AI, hops over it, and says to sort it out in the browser", () => {
    const scene = play();
    upToThePage(scene, MISSING);
    scene.hear({ kind: "leave" });
    scene.leapt();
    expect(scene.views.some((view) => view.auni?.face === "worry")).toBe(true);
    expect(scene.views.some((view) => view.said === "Your AI needs attention")).toBe(true);
    expect(scene.views.some((view) => view.said === "Let's set up your AI in the browser!")).toBe(
      true,
    );
    expect(scene.stage.view.stones[1]?.state).toBe("missing");
    scene.hear({ kind: "up", opened: true });
    scene.until(() => scene.signals.some(({ signal }) => signal === "ended"));
    expect(scene.stage.view.notes).toEqual([SIGN_IN_THERE]);

    // Signed in from the browser later, the scene left on the terminal fills the stone in place.
    const before = scene.frames.length;
    scene.hear({ kind: "brain", found: FOUND });
    expect(scene.stage.view.stones[1]).toEqual({ label: "Claude Code", state: "ready" });
    expect(scene.stage.view.notes).toEqual([FOUND.line]);
    expect(scene.frames.length).toBe(before + 1);
    expect(scene.frames.at(-1)).toContain("Claude Code");
    expect(scene.frames.at(-1)).not.toContain(SIGN_IN_THERE);
  });

  it("frowns only briefly once the browser is already opening on its page", () => {
    const frowned = (opening: boolean) => {
      const scene = play();
      scene.hear({ kind: "memory" });
      scene.hear({ kind: "firstRun", ahead: true });
      scene.hear({ kind: "page" });
      if (opening) scene.hear({ kind: "leave" });
      scene.run(200);
      const found = scene.now;
      scene.hear({ kind: "brain", found: MISSING });
      if (!opening) {
        // Asked to go only once it has started to frown.
        scene.until(() => scene.stage.view.auni?.face === "worry");
        scene.hear({ kind: "leave" });
      }
      const went = scene.leapt() - found;
      expect(scene.views.some((view) => view.auni?.face === "worry")).toBe(true);
      return went;
    };
    expect(frowned(true)).toBeLessThan(frowned(false) - 500);
  });

  it("waits on a brain check still running only so long once it has to go", () => {
    const scene = play();
    scene.hear({ kind: "memory" });
    scene.hear({ kind: "page" });
    scene.run(500);
    const asked = scene.now;
    scene.hear({ kind: "leave" });
    const went = scene.leapt();
    expect(went - asked).toBeGreaterThanOrEqual(BRAIN_WAIT_MS);
    expect(went - asked).toBeLessThan(BRAIN_WAIT_MS + 3_000);
  });

  it("stays where no browser opened, pointing at the address under it", () => {
    const scene = play();
    upToThePage(scene, MISSING);
    scene.hear({ kind: "say", line: "\nAuni is at http://localhost:3000" });
    scene.hear({ kind: "up", opened: false });
    scene.until(() => scene.signals.some(({ signal }) => signal === "ended"));
    expect(scene.signals.map(({ signal }) => signal)).toEqual(["ended"]);
    expect(scene.stage.view.auni).not.toBeNull();
    expect(scene.stage.view.said).toBe("Open Auni at the address below");
    expect(scene.stage.view.notes).toEqual(["Auni is at http://localhost:3000", MISSING.line]);
  });

  it("is quick once the first take is behind the owner, and when behind a page already up", () => {
    const timed = (ahead: boolean) => {
      const scene = play();
      scene.hear({ kind: "firstRun", ahead });
      scene.hear({ kind: "memory" });
      scene.hear({ kind: "brain", found: FOUND });
      // The page comes up as slowly as Auni's whole hop to it.
      scene.until(() => scene.stage.view.step === "page" && scene.stage.view.auni?.lift === 0);
      scene.hear({ kind: "page" });
      scene.hear({ kind: "leave" });
      return scene.leapt();
    };
    expect(timed(false)).toBeLessThan(timed(true) - 800);
    // Its page up before it got going, it hurries over to it.
    const behind = play();
    behind.hear({ kind: "firstRun", ahead: true });
    behind.hear({ kind: "memory" });
    behind.hear({ kind: "brain", found: FOUND });
    behind.hear({ kind: "page" });
    behind.hear({ kind: "leave" });
    expect(behind.leapt()).toBeLessThan(timed(true) - 800);
  });

  it("clears itself off the terminal as Auni stops", () => {
    const scene = play();
    scene.run(300);
    scene.stage.clear();
    expect(scene.frames.at(-1)).toContain("\u001B[J");
    const drawn = scene.frames.length;
    scene.run(300);
    expect(scene.frames.length).toBe(drawn);
  });
});
