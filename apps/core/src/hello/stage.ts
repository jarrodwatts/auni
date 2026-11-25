import { renderScene, SKY_ROWS, standingX, type ColorMode, type SceneState } from "./scene.ts";
import type { Face } from "./sprite.ts";

// The terminal moment as `auni` starts, played (scene.ts draws each frame): Auni drops onto its
// first stone, then hops each one as what it stands for really comes up, its memory (the
// database), its brain (your AI) and your page (the web app), and the moment the page is ready
// it says goodbye and leaps off the terminal's right edge, as the browser opens on it (it takes
// a moment to come up, which the leap fills). With no AI here it frowns at the brain's empty
// stone and hops over it. After the leap the empty sky folds away and what
// to know is left under the stones; a brain the owner signs in later fills its stone there.
//
// Nothing here waits on anything but what it is told: it runs in a worker (stage-worker.ts), so
// it moves on while Auni's own thread is busy loading, and it is driven by the clock it is
// given, so a test can play it frame by frame.

/** What the brain check found, as the owner reads it. */
export type BrainFound =
  { readonly name: string; readonly line: string } | { readonly name: null; readonly line: string };

/** What happened, as Auni starts (telling.ts sends each). */
export type StageEvent =
  | { readonly kind: "memory" }
  | { readonly kind: "firstRun"; readonly ahead: boolean }
  | { readonly kind: "building" }
  | { readonly kind: "page" }
  | { readonly kind: "brain"; readonly found: BrainFound }
  /** The browser is opening: Auni goes. */
  | { readonly kind: "leave" }
  /** A line to leave under the stones. */
  | { readonly kind: "say"; readonly line: string }
  /** Auni is up, the browser opened or not: the scene ends with what to know, then "ended". */
  | { readonly kind: "up"; readonly opened: boolean }
  | { readonly kind: "columns"; readonly columns: number };

/** The scene has ended, its last frame drawn. */
export type StageSignal = "ended";

/**
 * One movement: `step` is called with how far through it is, 0 to 1. Its length is known as it
 * starts (a pause until words are typed out is as long as what's left of them then). A flourish
 * is dropped once the browser is opening, so nothing holds Auni up on its way out.
 */
interface Beat {
  readonly ms: number | (() => number);
  readonly step: (t: number) => void;
  readonly flourish?: boolean;
}

type Auni = NonNullable<SceneState["auni"]>;
type StoneState = SceneState["stones"][number]["state"];

/** How often the worker draws a frame (stage-worker.ts). */
export const FRAME_MS = 33;
const TYPE_MS = 22;
const HOP_MS = 560;
const HOP_PIXELS = 7;
const LEAP_PIXELS = 9;
const BLINK_EVERY_MS = 2_600;
/** The longest Auni waits on a brain check still running once the browser is ready to open. */
export const BRAIN_WAIT_MS = 3_000;

/** How tall the sky is, in pixels, which Auni falls into and leaps out of. */
const SKY_PIXELS = SKY_ROWS * 2;

/** With no AI here, the next step, once Auni has gone into the browser to take it with them. */
export const SIGN_IN_THERE = "Sign in to your AI in the browser.";

const STONE = { memory: 0, brain: 1, page: 2 } as const;
/** Where Auni stands to peer at a brain stone with nothing on it: at the memory stone's edge. */
const EDGE = standingX(STONE.memory) + 9;

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Where the story has got to: each step waits on what really happened before the next. */
type Step =
  "waking" | "memory" | "brain" | "page" | "leaving" | "gone" | "folding" | "staying" | "ended";

interface StageOptions {
  readonly color: ColorMode;
  /** The terminal's width, which Auni leaps off the edge of. */
  readonly columns: number;
  /** The clock's time as the scene starts. */
  readonly now: number;
  /** Puts a frame on the terminal. */
  readonly write: (frame: string) => void;
  readonly signal: (signal: StageSignal) => void;
}

export class Stage {
  private auni: Auni | null = {
    x: standingX(STONE.memory),
    lift: SKY_PIXELS,
    face: "open",
    look: 0,
    squash: 0,
  };
  private readonly stones: { label: string; state: StoneState }[] = [
    { label: "Memory", state: "working" },
    { label: "Your AI", state: "waiting" },
    { label: "Web app", state: "waiting" },
  ];
  private said: string | null = null;
  private typed = 0;
  private notes: string[] = [];
  /** The lines on screen, under which the cursor waits. */
  private shown: string[] = [];
  /** How many rows of the empty sky have folded away once Auni has gone. */
  private folded = 0;
  private tickCount = 0;

  private queue: Beat[] = [];
  private beat: { readonly beat: Beat; readonly ms: number; done: number } | null = null;
  private lastFrame: number;
  private lastBlink: number;

  private step: Step = "waking";
  // What really happened.
  private memory = false;
  private page = false;
  private building = false;
  private brain: BrainFound | null = null;
  private leaveAsked = false;
  private up: { readonly opened: boolean } | null = null;
  /** When Auni was asked to go (leave, or up with no browser), for how long it waits on a brain. */
  private goAskedAt: number | null = null;
  private readonly kept: string[] = [];
  /** Past first run, the hop is quick: no cheering, and half the time in the air. */
  private quick = false;
  private columns: number;
  private readonly options: StageOptions;

  constructor(options: StageOptions) {
    this.options = options;
    this.columns = options.columns;
    this.lastFrame = options.now;
    this.lastBlink = options.now;
    this.say("Starting Auni");
    this.then(520, (t) => this.move({ lift: SKY_PIXELS * (1 - t) ** 2 }));
    this.then(200, (t) => this.move({ squash: 0.45 * (1 - t) }));
  }

  /** What Auni is doing, as a test reads it. */
  get view(): {
    readonly step: Step;
    readonly auni: Auni | null;
    readonly said: string | null;
    readonly stones: readonly { readonly label: string; readonly state: StoneState }[];
    readonly notes: readonly string[];
  } {
    return {
      step: this.step,
      auni: this.auni,
      said: this.said,
      stones: this.stones,
      notes: this.notes,
    };
  }

  hear(event: StageEvent, now: number): void {
    switch (event.kind) {
      case "memory":
        this.memory = true;
        this.stones[STONE.memory]!.state = "ready";
        if (this.stones[STONE.brain]!.state === "waiting")
          this.stones[STONE.brain]!.state = "working";
        break;
      case "firstRun":
        this.quick = !event.ahead;
        break;
      case "building":
        this.building = true;
        if (this.step === "page" && !this.page) this.say("Building the web app");
        break;
      case "page":
        this.page = true;
        this.stones[STONE.page]!.state = "ready";
        break;
      case "brain":
        this.brain = event.found;
        // The stone names what Auni found to think with, the moment it's known.
        this.stones[STONE.brain] = event.found.name
          ? { label: event.found.name, state: "ready" }
          : { label: "Your AI", state: "missing" };
        // Found after the scene has ended (the owner signed in from the browser), the stones
        // and what to know under them say so, as they would have had it been here all along.
        if (this.step === "ended" && event.found.name && this.shown.length > 0) {
          this.notes = this.summary();
          this.draw();
        }
        break;
      case "leave":
        this.leaveAsked = true;
        this.goAskedAt ??= now;
        this.queue = this.queue.filter(({ flourish }) => !flourish);
        // With its brain found and nothing left to type, it says goodbye at once, as it hops on,
        // so the words are whole before the browser comes up over them.
        if (this.brain?.name && this.typingLeft() === 0) {
          this.said = this.goodbye;
          this.typed = 0;
        }
        break;
      case "say":
        this.kept.push(...event.line.trim().split("\n").filter(Boolean));
        break;
      case "up":
        this.up = { opened: event.opened };
        this.goAskedAt ??= now;
        break;
      case "columns":
        this.columns = event.columns;
        break;
    }
    this.next(now);
  }

  /** Plays what the time since the last frame covers, and draws the frame. */
  tick(now: number): void {
    if (this.step === "ended") return;
    let elapsed = now - this.lastFrame;
    this.lastFrame = now;
    this.tickCount = Math.floor(now / 140);
    if (this.said !== null && this.typed < this.said.length)
      this.typed = Math.min(this.said.length, this.typed + Math.ceil(elapsed / TYPE_MS));
    while (true) {
      if (!this.beat) {
        const next = this.queue.shift();
        if (!next) break;
        this.beat = { beat: next, ms: typeof next.ms === "number" ? next.ms : next.ms(), done: 0 };
      }
      const played = Math.min(this.beat.ms - this.beat.done, elapsed);
      this.beat.done += played;
      elapsed -= played;
      const t = this.beat.ms === 0 ? 1 : this.beat.done / this.beat.ms;
      this.beat.beat.step(t);
      if (t < 1) break;
      this.beat = null;
    }
    // Waiting for what comes next, Auni blinks now and then.
    if (this.idle && this.auni?.face === "open" && now - this.lastBlink > BLINK_EVERY_MS) {
      this.lastBlink = now;
      this.face("shut", this.auni.look);
      this.then(130);
      this.face("open", this.auni.look);
    }
    this.draw();
    this.next(now);
  }

  /** Takes the scene off the terminal, as Auni stops or fails to start: what it says reads better alone. */
  clear(): void {
    if (this.step !== "ended") this.options.write(redraw(this.shown, []));
    this.shown = [];
    this.step = "ended";
  }

  private get idle(): boolean {
    return !this.beat && this.queue.length === 0;
  }

  /** The next step of the story, once the last has played and what it waits on has happened. */
  private next(now: number): void {
    if (!this.idle) return;
    switch (this.step) {
      case "waking": {
        if (!this.memory) return;
        this.step = "memory";
        this.cheer();
        this.say("Let me see who's here");
        this.face("open", 1);
        return;
      }
      case "memory": {
        if (this.brain?.name) {
          this.say("There it is!");
          this.face("open", 0);
          this.hop(standingX(STONE.brain));
          // Behind a page already waiting, it doesn't stop to cheer.
          if (!this.page) this.cheer();
        } else if (this.brain) {
          // To the edge of the empty stone, to frown at it.
          this.hop(EDGE);
          this.face("worry", 1);
          this.say("I need an AI to think with");
          // Long enough to read, and shorter with the browser already opening on its page.
          this.then(this.quick || this.leaveAsked ? 700 : 1_400);
        } else if (!this.gaveUpOnBrain(now)) return;
        this.step = "brain";
        return;
      }
      case "brain": {
        if (!this.page) this.stones[STONE.page]!.state = "working";
        // With the browser already opening on its page, it says goodbye as it hops over.
        this.say(
          this.page && this.leaveAsked
            ? this.goodbye
            : this.page
              ? "Your page is ready"
              : this.building
                ? "Building the web app"
                : "Starting the web app",
        );
        this.face("open", 0);
        // From the memory's stone, over the brain's, it's a long way: a bigger hop.
        const far = standingX(STONE.page) - (this.auni?.x ?? 0) > standingX(STONE.brain);
        this.hop(standingX(STONE.page), far ? 1.5 : 1);
        this.step = "page";
        return;
      }
      case "page": {
        if (!this.page) return;
        if (this.leaveAsked) {
          this.leap();
          this.step = "leaving";
        } else if (this.up && !this.up.opened && (this.brain || this.gaveUpOnBrain(now))) {
          const words = "Come find me at the address below";
          this.say(words);
          this.face("open", 0);
          // Typed in full before the scene ends.
          this.then(words.length * TYPE_MS);
          this.step = "staying";
        }
        return;
      }
      case "leaving": {
        this.auni = null;
        this.step = "gone";
        this.next(now);
        return;
      }
      case "gone": {
        if (!this.up) return;
        // The sky it left folds away a row at a time, the stones rising with it.
        for (let row = 1; row < SKY_ROWS; row++) this.then(FRAME_MS, () => (this.folded = row));
        this.step = "folding";
        return;
      }
      case "folding":
      case "staying":
        this.end();
        return;
      case "ended":
        return;
    }
  }

  /** Once Auni has to go, it waits on a brain still being checked only so long. */
  private gaveUpOnBrain(now: number): boolean {
    return this.goAskedAt !== null && now - this.goAskedAt >= BRAIN_WAIT_MS;
  }

  /** The last frame: the stones, and what to know under them. */
  private end(): void {
    this.notes = this.summary();
    this.draw();
    this.step = "ended";
    this.options.signal("ended");
  }

  /** What to know under the stones once Auni is up. */
  private summary(): string[] {
    const fix = this.brain && !this.brain.name ? this.brain.line : null;
    // Where Auni is comes first, the one line drawn bold, with or without an AI.
    return [
      ...this.kept,
      ...(this.brain?.name ? [this.brain.line] : []),
      // What fixes the brain is said here only where no browser opened to do it in.
      ...(fix ? (this.up?.opened ? [SIGN_IN_THERE] : fix.split("\n")) : []),
    ];
  }

  private get goodbye(): string {
    return this.brain && !this.brain.name
      ? "Let's set up your AI in the browser!"
      : "See you in your browser!";
  }

  /** How long what Auni is saying takes to finish typing. */
  private typingLeft(): number {
    return this.said === null ? 0 : Math.max(0, this.said.length - this.typed) * TYPE_MS;
  }

  /** Its goodbye, then off the stone and out through the terminal's right edge. */
  private leap(): void {
    this.say(this.goodbye);
    this.face("open", 1);
    // Long enough to read it whole: the rest of its typing, and a moment.
    this.then(() => this.typingLeft() + 150);
    let from = 0;
    this.then(120, (t) => {
      from = this.auni?.x ?? from;
      this.move({ squash: 0.5 * t });
    });
    const to = this.columns + 4;
    this.then(460, (t) => {
      // Off the stone, it leaves its words behind, and passes clear of them.
      if (t > 0.15) this.said = null;
      this.move({
        x: from + (to - from) * t * t,
        // A low arc, under the words it leaves behind, so all of it shows as it goes.
        lift: LEAP_PIXELS * Math.sin(Math.PI * Math.min(1, t * 0.75)),
        squash: -0.3,
      });
    });
  }

  private draw(): void {
    const lines = renderScene(
      {
        stones: this.stones,
        auni: this.auni,
        bubble: this.said === null ? null : { text: this.said, shown: this.typed },
        notes: this.notes,
        tick: this.tickCount,
      },
      this.options.color,
      // Never into the last column, where a terminal wraps.
      this.columns - 1,
    );
    const next = lines.slice(this.folded);
    const frame = redraw(this.shown, next);
    if (frame) this.options.write(frame);
    this.shown = next;
  }

  private then(ms: Beat["ms"], step: (t: number) => void = () => {}, flourish = false): void {
    this.queue.push({ ms, step, flourish });
  }

  private move(to: Partial<Auni>): void {
    if (this.auni) this.auni = { ...this.auni, ...to };
  }

  private say(words: string): void {
    this.then(0, () => {
      if (this.said !== words) this.typed = 0;
      this.said = words;
    });
  }

  private face(pulled: Face, look: -1 | 0 | 1 = 0): void {
    this.then(0, () => this.move({ face: pulled, look }));
  }

  /**
   * A hop from where Auni stands to column `to`: up, across and down, stretching as it goes and
   * squashing as it lands. `reach` makes it higher and longer, for a wider gap. Past first run,
   * or behind a page already up, it is quick.
   */
  private hop(to: number, reach = 1): void {
    // Quick past first run, and quick to catch up with a page already waiting for it.
    const scale = this.quick || this.page ? 0.5 : 1;
    let from = 0;
    this.then(140 * scale, (t) => {
      from = this.auni?.x ?? from;
      this.move({ squash: 0.35 * Math.sin(Math.PI * t) });
    });
    this.then(HOP_MS * scale * reach, (t) =>
      this.move({
        x: from + (to - from) * ease(t),
        lift: HOP_PIXELS * reach * Math.sin(Math.PI * t),
        squash: t < 0.85 ? -0.2 : 0.4,
      }),
    );
    this.then(180 * scale, (t) => this.move({ lift: 0, squash: 0.4 * (1 - t) }));
  }

  /** A happy moment: eyes shut in a smile, a little bounce. A flourish, dropped on the way out. */
  private cheer(): void {
    if (this.quick) return;
    this.then(0, () => this.move({ face: "joy", look: 0 }), true);
    this.then(320, (t) => this.move({ squash: -0.12 * Math.sin(Math.PI * t) }), true);
    this.face("open");
  }
}

const SYNC_START = "\u001B[?2026h";
const SYNC_END = "\u001B[?2026l";

/**
 * What takes the terminal from `before` (the lines on screen, the cursor at the start of the row
 * under them) to `after`: only the rows that changed are written, each over its cleared row, and
 * the cursor is left under the last. Wrapped in synchronized output, so a terminal that knows it
 * paints the frame at once (one that doesn't ignores it). Empty when nothing changed.
 */
export function redraw(before: readonly string[], after: readonly string[]): string {
  // The row the cursor is on, counted from the top of the scene.
  let row = before.length;
  const to = (target: number) => {
    const moved =
      target < row ? `\u001B[${row - target}F` : target > row ? `\u001B[${target - row}E` : "";
    row = target;
    return moved;
  };
  let out = "";
  after.forEach((line, index) => {
    if (index < before.length && before[index] === line) return;
    out += `${to(index)}\u001B[2K${line}\n`;
    row = index + 1;
  });
  out += after.length < before.length ? `${to(after.length)}\u001B[J` : to(after.length);
  return out === "" ? "" : `${SYNC_START}${out}${SYNC_END}`;
}
