import { onFrame, Spring } from "@/lib/spring";

import {
  bodyScale,
  clamp,
  edgeCue,
  EYES,
  flipsCap,
  placeY,
  poke,
  restPose,
  rubber,
  type Cue,
  type EdgeScene,
  type Mood,
  type Place,
} from "./edge-pose";
import { gaze } from "./gaze";

/** The pieces of Auni on the page, all placed from the card's top left corner. */
interface EdgeParts {
  /** Holds the face's settings and mood; it sits on the card's top edge and takes no room. */
  readonly root: HTMLElement;
  /** Auni itself, behind the card. */
  readonly body: HTMLElement;
  /** The cap, on its own for the moment it flies off. */
  readonly cap: HTMLElement;
  /** Two paws over the edge, in front of the card. */
  readonly paws: readonly HTMLElement[];
  /** The soft shadow where Auni meets the card. */
  readonly contact: HTMLElement;
  /** The part of Auni above the edge, where it can be poked. */
  readonly hit: HTMLElement;
  /** The card it's on. */
  readonly card: HTMLElement;
  /** The class a z it snores wears. */
  readonly z: string;
}

/** The size the motion was tuned at; distances and speeds scale from it. */
const TUNED = 86;
/** How far the face turns toward what Auni looks at, in the artwork's units. */
const REACH = { x: 12, y: 9 } as const;
/** Where the paws hold the edge, as fractions of Auni's width. */
const PAWS = [0.27, 0.79] as const;
/** A pointer this close to Auni is someone it notices. */
const NOTICE_PX = 340;
/** A pointer this close wakes it. */
const WAKE_PX = 200;
/** A pointer this close to the card's button has Auni lean toward it. */
const LEAN_PX = 90;
/** This long at rest with no one near, and it dozes. */
const DOZE_AFTER_S = 14;
/** Where a flipped cap is held, by device, so the big finish never comes twice running. */
const FLIP_KEY = "auni:edge-flip";

interface Paw {
  readonly el: HTMLElement;
  readonly at: number;
  readonly y: Spring;
  readonly opacity: Spring;
  readonly squash: Spring;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Auni, alive over a card's edge. Every part of it is a spring that keeps its
 * speed, so nothing snaps: the body's stretch, the cap's swing and the eyes
 * all follow from how it moves. The card's state sets where it rests and the
 * face it pulls; the moments in between (a hop on the tap, a nod per row, a
 * jump at the finish) play out on top. Where motion is reduced it holds
 * still in each pose and only its face changes.
 */
export class EdgeRig {
  private readonly parts: EdgeParts;
  private readonly size: number;
  /** Distances and speeds tuned at one size, for this one. */
  private readonly scale: number;
  private readonly still: boolean;

  private readonly x = new Spring(0, 260, 26);
  private readonly y: Spring;
  private readonly tilt = new Spring(0, 160, 16);
  private readonly squash = new Spring(0, 560, 13);
  private readonly capSwing = new Spring(0, 240, 8);
  private readonly faceX = new Spring(0, 520, 34);
  private readonly faceY = new Spring(0, 520, 34);
  private readonly lid = new Spring(1, 1400, 60);
  private readonly contact = new Spring(0, 200, 28);
  private readonly paws: readonly Paw[];

  private scene: EdgeScene | null = null;
  /** Bumped by anything that takes over Auni, so a sequence it interrupts stops where it is. */
  private turn = 0;
  /** A sequence is playing, and it, not the scene, says where Auni is. */
  private busy = false;
  private gripping = false;
  private mood: Mood | null = null;
  /** A face held for a moment over the scene's own. */
  private held: { readonly mood: Mood; readonly until: number } | null = null;
  private leaning = false;
  private asleep = false;

  /** Seconds Auni has been on the page, counted only while it's drawn. */
  private time = 0;
  private waits: { readonly at: number; readonly done: () => void }[] = [];
  private flight: {
    readonly gravity: number;
    readonly land: number;
    readonly done: () => void;
  } | null = null;
  private spin: { readonly from: number; readonly length: number; readonly turns: number } | null =
    null;
  private spinDeg = 0;
  private capFlight: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    angle: number;
    readonly from: number;
    readonly done: () => void;
  } | null = null;

  private pointer: (Point & { readonly at: number }) | null = null;
  private glance: Point & { readonly until: number } = { x: 0, y: 0, until: 0 };
  private lastNear = 0;
  private nextBlink = 1.2;
  private nextZ = 0;
  private pokes: readonly number[] = [];
  private drag: { readonly from: number; moved: boolean } | null = null;
  /** Where Auni stands along the edge; null until the card is measured. */
  private home: number | null = null;
  private stopLoop: (() => void) | null = null;

  constructor(parts: EdgeParts, size: number, still: boolean) {
    this.parts = parts;
    this.size = size;
    this.scale = size / TUNED;
    this.still = still;
    this.y = new Spring(placeY("hidden", size), 300, 24);
    this.paws = parts.paws.map((el, index) => ({
      el,
      at: PAWS[index] ?? 0.5,
      y: new Spring(10 * this.scale, 600, 30),
      opacity: new Spring(0, 300, 30),
      squash: new Spring(0, 700, 16),
    }));
    this.layout(parts.card.offsetWidth);
    // Held still, Auni neither follows the pointer nor plays.
    if (!still) {
      window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      parts.hit.addEventListener("pointerdown", this.onPointerDown);
      parts.hit.addEventListener("pointermove", this.onDrag);
      parts.hit.addEventListener("pointerup", this.onPointerUp);
      parts.hit.addEventListener("pointercancel", this.onPointerUp);
    }
    this.render();
  }

  /** Stands Auni toward the card's right, clear of its corner, as wide as the card is. */
  layout(width: number): void {
    const first = this.home === null;
    this.home = clamp(width * 0.72 - this.size / 2, 12, width - this.size - 12);
    if (first || this.still) this.x.snap(this.home);
    else this.x.to(this.home);
    if (this.still) this.render();
  }

  /** The card moved on: Auni reacts to the moment, then rests in the pose for it. */
  show(scene: EdgeScene): void {
    const from = this.scene;
    this.scene = scene;
    this.lastNear = this.time;
    if (this.still) {
      this.hold(restPose(scene));
      return;
    }
    if (this.asleep) this.wake();
    if (from === null) {
      // Up from behind the card, paws first.
      void this.play((turn) => this.beat(turn, 120));
      return;
    }
    const cue = edgeCue(from, scene);
    if (cue === "next") this.nod(0.55);
    else if (cue) void this.play((turn) => this.react(cue, turn));
    else if (!this.busy) this.settle();
  }

  /** Draws and moves only while the card is on screen. */
  resume(): void {
    if (this.still || this.stopLoop) return;
    this.stopLoop = onFrame(this.frame);
  }

  pause(): void {
    this.stopLoop?.();
    this.stopLoop = null;
  }

  destroy(): void {
    this.pause();
    this.turn += 1;
    window.removeEventListener("pointermove", this.onPointerMove);
    const { cap, hit, root } = this.parts;
    // Gone mid-wink or mid-flip, it leaves nothing behind for whatever comes next.
    delete root.dataset.wink;
    delete root.dataset.capOff;
    cap.style.visibility = "hidden";
    hit.removeEventListener("pointerdown", this.onPointerDown);
    hit.removeEventListener("pointermove", this.onDrag);
    hit.removeEventListener("pointerup", this.onPointerUp);
    hit.removeEventListener("pointercancel", this.onPointerUp);
  }

  // ---- where it rests ----

  private restY(): number {
    const place: Place = this.scene ? restPose(this.scene).place : "peek";
    return placeY(place, this.size) - (this.leaning ? 6 * this.scale : 0);
  }

  /** Back to the scene's own pose, from wherever a moment left it. */
  private settle(): void {
    if (!this.scene) return;
    const pose = restPose(this.scene);
    this.held = null;
    if (this.home !== null) this.x.to(this.home, 260, 26);
    this.y.to(this.restY(), 300, 24);
    this.grip(pose.grip);
    this.contact.to(1);
  }

  /** Reduced motion: straight to the pose, looking where the scene looks, and still. */
  private hold(pose: ReturnType<typeof restPose>): void {
    this.y.snap(placeY(pose.place, this.size));
    this.gripping = pose.grip;
    for (const paw of this.paws) {
      paw.y.snap(0);
      paw.opacity.snap(pose.grip ? 1 : 0);
    }
    this.contact.snap(1);
    this.aim();
    this.faceX.snap(this.faceX.target);
    this.faceY.snap(this.faceY.target);
    this.tilt.snap(0);
    this.render();
  }

  // ---- the frame ----

  private readonly frame = (dt: number): void => {
    this.time += dt;
    const due = this.waits.filter((wait) => wait.at <= this.time);
    if (due.length > 0) {
      this.waits = this.waits.filter((wait) => wait.at > this.time);
      for (const wait of due) wait.done();
    }
    if (this.held && this.time >= this.held.until) this.held = null;
    this.idle();
    this.aim();
    this.flyCap(dt);
    // Four small steps a frame keep the stiffest springs steady.
    for (let index = 0; index < 4; index += 1) this.step(dt / 4);
    this.render();
  };

  private step(dt: number): void {
    const { flight, y } = this;
    if (flight) {
      y.v += flight.gravity * dt;
      y.x += y.v * dt;
      if (y.v > 0 && y.x >= flight.land) {
        // It lands, and the landing squashes it as hard as it came down.
        this.squash.kick((y.v / this.scale) * 0.0042);
        y.snap(flight.land);
        this.flight = null;
        flight.done();
      }
    } else {
      y.step(dt);
    }
    for (const spring of [
      this.x,
      this.tilt,
      this.squash,
      this.capSwing,
      this.faceX,
      this.faceY,
      this.lid,
      this.contact,
    ]) {
      spring.step(dt);
    }
    for (const paw of this.paws) {
      paw.y.step(dt);
      paw.opacity.step(dt);
      paw.squash.step(dt);
    }
  }

  /**
   * What Auni looks at: a cap in the air, else the row it's working on, else
   * the card's button with the pointer close to it, else a pointer near it,
   * else a glance about.
   */
  private aim(): void {
    const near = this.nearPointer();
    const button = this.scene?.kind === "ready" && near && !this.still ? this.button(near) : null;
    if ((button !== null) !== this.leaning) {
      // Leaning in toward the button the pointer is reaching for.
      this.leaning = button !== null;
      if (!this.busy && !this.drag && !this.asleep) this.y.to(this.restY());
    }
    const look = this.capFlight ? this.capPoint() : (this.workPoint() ?? button ?? near);
    let toward: Point;
    if (look) {
      const eye = this.eyePoint();
      toward = gaze(look.x - eye.x, look.y - eye.y, 150 * this.scale);
    } else if (this.still) {
      toward = { x: 0, y: 0 };
    } else {
      if (this.time > this.glance.until) {
        this.glance = {
          x: (Math.random() - 0.5) * 0.9,
          y: (Math.random() - 0.5) * 0.6,
          until: this.time + 0.9 + Math.random() * 2.2,
        };
      }
      toward = this.glance;
    }
    this.faceX.to(toward.x * REACH.x);
    this.faceY.to(toward.y * REACH.y);
    // The head follows the eyes a little, and leans into sideways moves.
    this.tilt.to(toward.x * 8 + clamp((this.x.v / this.scale) * 0.02, -8, 8));
    // The cap trails behind whatever way the body goes.
    this.capSwing.to(clamp((-this.x.v * 0.035 + this.y.v * 0.02) / this.scale, -28, 28));
  }

  /** The row the card is working on, or the action of the one that needs the person. */
  private workPoint(): Point | null {
    const { scene } = this;
    if (scene?.kind === "running" && scene.row) return this.rowPoint(scene.row, 0.3, 0.5);
    if (scene?.kind !== "attention") return null;
    // A row's action sits at its right, under its name; the card's own retry at its right.
    return scene.row
      ? this.rowPoint(scene.row, 0.85, 0.8)
      : this.at(this.parts.card.getBoundingClientRect(), 0.85, 0.6);
  }

  /** The card's own button, while the pointer is close to it. */
  private button(pointer: Point): Point | null {
    const button = this.parts.card.querySelector<HTMLElement>('[data-tone="primary"]');
    if (!button) return null;
    const box = button.getBoundingClientRect();
    const dx = Math.max(box.left - pointer.x, 0, pointer.x - box.right);
    const dy = Math.max(box.top - pointer.y, 0, pointer.y - box.bottom);
    return Math.hypot(dx, dy) < LEAN_PX ? this.at(box, 0.5, 0.2) : null;
  }

  private rowPoint(row: string, x: number, y: number): Point | null {
    const element =
      this.parts.card.querySelector<HTMLElement>(`[data-row="${CSS.escape(row)}"]`) ??
      // A row behind "N more" is watched there.
      this.parts.card.querySelector<HTMLElement>('[data-row="more"]');
    return element ? this.at(element.getBoundingClientRect(), x, y) : null;
  }

  private at(box: DOMRect, x: number, y: number): Point {
    return { x: box.left + box.width * x, y: box.top + box.height * y };
  }

  private eyePoint(): Point {
    const stage = this.parts.root.getBoundingClientRect();
    return {
      x: stage.left + this.x.x + EYES.x * this.size,
      y: stage.top + this.y.x + EYES.y * this.size,
    };
  }

  private nearPointer(): Point | null {
    const { pointer } = this;
    if (!pointer || this.time - pointer.at > 3) return null;
    const eye = this.eyePoint();
    return Math.hypot(pointer.x - eye.x, pointer.y - eye.y) < NOTICE_PX ? pointer : null;
  }

  /** Blinks now and then, and with no one about while the card waits on money or is done, dozes off. */
  private idle(): void {
    if (this.time >= this.nextBlink) {
      this.nextBlink = this.time + 1.8 + Math.random() * 2.8;
      const face = this.face();
      if (face === "calm" || face === "work" || face === "up") {
        if (Math.random() < 0.04) this.wink();
        else {
          this.blink();
          if (Math.random() < 0.22) void this.wait(210).then(() => this.blink());
        }
      }
    }
    // A card ready for the person's tap keeps Auni up with them; one waiting on money, or done, may not.
    const resting = this.scene?.kind === "funding" || this.scene?.kind === "landed";
    if (
      !this.asleep &&
      resting &&
      !this.busy &&
      !this.drag &&
      this.time - this.lastNear > DOZE_AFTER_S
    ) {
      this.doze();
    }
    if (this.asleep && this.time >= this.nextZ) {
      this.nextZ = this.time + 1.6;
      this.snore();
    }
  }

  // ---- drawing ----

  private face(): Mood {
    if (this.asleep) return "sleep";
    if (this.held) return this.held.mood;
    if (this.scene?.kind === "ready" && this.leaning) return "up";
    return this.scene ? restPose(this.scene).mood : "calm";
  }

  private render(): void {
    const { body, contact, hit, root } = this.parts;
    const { size } = this;
    const mood = this.face();
    if (mood !== this.mood) {
      // A change of face is a little pop of the whole body.
      if (this.mood !== null && !this.still) this.squash.kick(-0.9);
      this.mood = mood;
      root.dataset.mood = mood;
    }
    const breath = this.still ? 0 : Math.sin((this.time * Math.PI * 2) / 3.2) * 0.011;
    const scale = bodyScale(this.y.v / this.size, this.squash.x, breath);
    // It tilts and squashes about its bottom, and spins about its middle.
    const bottom = { x: size * 0.52, y: size * 0.88 };
    const middle = { x: size * 0.52, y: size * 0.55 };
    body.style.transform = [
      `translate(${px(this.x.x + bottom.x)}, ${px(this.y.x + bottom.y)})`,
      `rotate(${deg(this.tilt.x)})`,
      `translate(${px(middle.x - bottom.x)}, ${px(middle.y - bottom.y)})`,
      `rotate(${deg(this.spinDeg)})`,
      `translate(${px(bottom.x - middle.x)}, ${px(bottom.y - middle.y)})`,
      `scale(${scale.x.toFixed(4)}, ${scale.y.toFixed(4)})`,
      `translate(${px(-bottom.x)}, ${px(-bottom.y)})`,
    ].join(" ");
    root.style.setProperty("--auni-eye-x", px(this.faceX.x));
    root.style.setProperty("--auni-eye-y", px(this.faceY.x));
    root.style.setProperty("--auni-cap", deg(this.capSwing.x));
    root.style.setProperty("--auni-lid", clamp(this.lid.x, 0.06, 1.2).toFixed(3));

    // Paws hold the edge where the body is; one that lets go falls away and fades.
    const paw = { width: size * 0.2, height: size * 0.13 };
    for (const each of this.paws) {
      const left = this.x.x + size * each.at - paw.width / 2;
      const top = each.y.x - paw.height * 0.55;
      each.el.style.transform = `translate(${px(left)}, ${px(top)}) scale(${(1 + each.squash.x).toFixed(3)}, ${(1 - each.squash.x).toFixed(3)})`;
      each.el.style.opacity = clamp(each.opacity.x, 0, 1).toFixed(3);
    }
    // The shadow is deepest with Auni right over the edge.
    const press = clamp(1 - Math.abs(this.y.x - placeY("peek", size)) / (40 * this.scale), 0, 1);
    contact.style.transform = `translate(${px(this.x.x + size * 0.16)}, ${px(-3 * this.scale)})`;
    contact.style.opacity = clamp(this.contact.x * (0.45 + press * 0.55), 0, 1).toFixed(3);
    // Only what shows over the edge can be poked; the card under it stays the card's.
    const top = this.y.x + size * 0.18;
    hit.style.transform = `translate(${px(this.x.x + size * 0.2)}, ${px(top)})`;
    hit.style.height = px(Math.max(0, -top));
  }

  // ---- small moves ----

  private grip(on: boolean, stagger = 70): void {
    if (on === this.gripping) return;
    this.gripping = on;
    this.paws.forEach((paw, index) => {
      void this.wait(index * stagger).then(() => {
        if (this.gripping !== on) return;
        if (on) {
          paw.y.snap(10 * this.scale).to(0);
          paw.opacity.to(1, 400, 30);
          paw.squash.kick(-3);
        } else {
          paw.y.to(16 * this.scale, 180, 14);
          paw.opacity.to(0, 260, 30);
        }
      });
    });
  }

  private pawTap(): void {
    this.paws.forEach((paw, index) => {
      void this.wait(index * 90).then(() => {
        paw.y.kick(-60 * this.scale);
        paw.squash.kick(4);
      });
    });
  }

  private nod(amount: number): void {
    this.y.kick(90 * this.scale * amount);
    this.squash.kick(0.9 * amount);
    this.pawTap();
  }

  private hop(height: number): void {
    this.y.kick(-260 * this.scale * height);
    this.squash.kick(-1.4 * height);
  }

  private shake(times: number, strength: number): void {
    for (let index = 0; index < times; index += 1) {
      void this.wait(index * 70).then(() => this.tilt.kick((index % 2 ? -1 : 1) * strength * 18));
    }
  }

  private blink(): void {
    this.lid.to(0.04);
    void this.wait(80).then(() => this.lid.to(1));
  }

  private wink(): void {
    const { root } = this.parts;
    root.dataset.wink = "";
    this.squash.kick(-0.6);
    void this.wait(420).then(() => delete root.dataset.wink);
  }

  private feel(mood: Mood, ms: number): void {
    this.held = { mood, until: this.time + ms / 1000 };
  }

  /** A real jump: crouch, leave the edge, fall back under gravity, squash on landing. */
  private async jump(turn: number, speed: number, gravity: number, spins: number): Promise<void> {
    this.squash.kick(4.5);
    if (!(await this.beat(turn, 110))) return;
    const lift = -speed * this.scale;
    const fall = gravity * this.scale;
    this.y.v = lift;
    this.squash.kick(-6);
    if (spins > 0)
      this.spin = { from: this.time, length: ((2 * -lift) / fall) * 0.92, turns: spins };
    await new Promise<void>((done) => {
      this.flight = { gravity: fall, land: placeY("sit", this.size), done };
    });
  }

  // ---- the moments ----

  /** Plays a moment through, then rests in the scene's pose, unless another moment took over. */
  private async play(sequence: (turn: number) => Promise<unknown>): Promise<void> {
    this.turn += 1;
    const turn = this.turn;
    this.busy = true;
    this.flight = null;
    await sequence(turn);
    if (turn !== this.turn) return;
    this.busy = false;
    this.settle();
  }

  private react(cue: Exclude<Cue, "next">, turn: number): Promise<void> {
    switch (cue) {
      case "funded":
        return this.funded(turn);
      case "start":
        return this.start(turn);
      case "worry":
        return this.worry(turn);
      case "retried":
        return this.retried(turn);
      case "finish":
        return this.finish(turn);
      case "slump":
        return this.slump(turn);
    }
  }

  /** Waits `ms` of Auni's own time; false once something else has taken over. */
  private async beat(turn: number, ms: number): Promise<boolean> {
    await this.wait(ms);
    return turn === this.turn;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((done) => this.waits.push({ at: this.time + ms / 1000, done }));
  }

  /** The money it waited on came in: up with a happy face, two hops, and ready for the tap. */
  private async funded(turn: number): Promise<void> {
    this.held = { mood: "happy", until: this.time + 1.6 };
    this.y.to(placeY("up", this.size), 260, 16);
    this.hop(0.5);
    if (!(await this.beat(turn, 420))) return;
    this.hop(0.35);
    await this.beat(turn, 700);
  }

  /** The person's tap: a hop of surprise, and to work. */
  private async start(turn: number): Promise<void> {
    this.feel("up", 450);
    this.hop(0.55);
    this.pawTap();
    await this.beat(turn, 450);
  }

  /** A row needs the person: it pulls itself up and turns to it, bobbing to be seen. */
  private async worry(turn: number): Promise<void> {
    this.held = { mood: "worried", until: Infinity };
    this.y.to(placeY("up", this.size), 240, 17);
    if (!(await this.beat(turn, 420))) return;
    this.hop(0.3);
    if (!(await this.beat(turn, 380))) return;
    this.hop(0.25);
    await this.beat(turn, 300);
  }

  /** A row tried again: a flinch, it lets go and drops, then paws back first and peeks up. */
  private async retried(turn: number): Promise<void> {
    this.held = { mood: "sad", until: Infinity };
    this.squash.kick(-2.2);
    if (!(await this.beat(turn, 120))) return;
    this.grip(false, 50);
    this.contact.to(0);
    this.y.to(placeY("hidden", this.size), 260, 20);
    if (!(await this.beat(turn, 800))) return;
    this.held = { mood: "work", until: Infinity };
    this.grip(true);
    if (!(await this.beat(turn, 260))) return;
    this.contact.to(1);
    this.y.to(placeY("eyes", this.size), 70, 15);
    if (!(await this.beat(turn, 700))) return;
    this.y.to(placeY("peek", this.size), 380, 15);
    await this.beat(turn, 400);
  }

  /** Everything landed: it jumps up to sit on the edge, and now and then flips its cap off. */
  private async finish(turn: number): Promise<void> {
    // A beat for the card to settle into its finished shape first.
    if (!(await this.beat(turn, 350))) return;
    this.grip(false);
    this.held = { mood: "happy", until: Infinity };
    if (flipsCap(Math.random(), flippedLast())) {
      remember(true);
      await this.capFlip(turn);
    } else {
      remember(false);
      await this.jump(turn, 900, 3400, 1);
    }
    if (!(await this.beat(turn, 250))) return;
    this.hop(0.4);
    if (!(await this.beat(turn, 500))) return;
    this.hop(0.3);
    await this.beat(turn, 400);
  }

  /** It didn't go through: Auni sinks down, sad. */
  private async slump(turn: number): Promise<void> {
    this.held = { mood: "sad", until: Infinity };
    this.squash.kick(-1.5);
    this.y.to(placeY("eyes", this.size), 120, 16);
    await this.beat(turn, 600);
  }

  /** A double backflip so big the cap flies off, and Auni catches it on its head. */
  private async capFlip(turn: number): Promise<void> {
    const jump = this.jump(turn, 1250, 3600, 2);
    if (!(await this.beat(turn, 260))) return;
    const { cap, root } = this.parts;
    root.dataset.capOff = "";
    cap.style.visibility = "visible";
    await new Promise<void>((done) => {
      this.capFlight = {
        x: this.x.x,
        y: this.y.x,
        vx: 70 * this.scale,
        vy: this.y.v - 420 * this.scale,
        angle: 0,
        from: this.time,
        done,
      };
    });
    await jump;
  }

  private flyCap(dt: number): void {
    if (this.spin) {
      const progress = clamp((this.time - this.spin.from) / this.spin.length, 0, 1);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      this.spinDeg = progress >= 1 ? 0 : eased * 360 * this.spin.turns;
      if (progress >= 1) this.spin = null;
    }
    const flying = this.capFlight;
    if (!flying) return;
    flying.vy += 2600 * this.scale * dt;
    flying.x += flying.vx * dt;
    flying.y += flying.vy * dt;
    flying.angle += 540 * dt;
    const { cap, root } = this.parts;
    cap.style.transform = `translate(${px(flying.x)}, ${px(flying.y)}) rotate(${deg(flying.angle)})`;
    const falling = flying.vy > 0 && flying.y >= this.y.x - 2;
    // Caught on its head once Auni has landed; a cap that falls first waits there for it.
    if (falling && this.flight) flying.y = this.y.x;
    if ((falling && !this.flight) || this.time - flying.from > 3) {
      this.capFlight = null;
      cap.style.visibility = "hidden";
      delete root.dataset.capOff;
      this.capSwing.kick(-420);
      this.squash.kick(3.5);
      flying.done();
    }
  }

  private capPoint(): Point {
    const box = this.parts.cap.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top };
  }

  // ---- easter eggs ----

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY, at: this.time };
    const eye = this.eyePoint();
    const distance = Math.hypot(event.clientX - eye.x, event.clientY - eye.y);
    if (distance < NOTICE_PX) this.lastNear = this.time;
    if (this.asleep && distance < WAKE_PX) this.wake();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.asleep) {
      this.wake();
      return;
    }
    if (this.busy) return;
    this.drag = { from: event.clientY, moved: false };
    this.parts.hit.setPointerCapture(event.pointerId);
  };

  /** Pulled up, Auni stretches like rubber. */
  private readonly onDrag = (event: PointerEvent): void => {
    const { drag } = this;
    if (!drag) return;
    const pulled = drag.from - event.clientY;
    if (pulled > 6 && !drag.moved) {
      drag.moved = true;
      this.held = { mood: "up", until: Infinity };
    }
    const lift = rubber(pulled, this.size);
    this.y.to(this.restY() - lift, 900, 60);
    this.squash.to(clamp(-lift / (this.size * 1.6), -0.3, 0), 900, 60);
  };

  /** Let go, it springs back; a tap without a pull is a poke. */
  private readonly onPointerUp = (event: PointerEvent): void => {
    const { drag } = this;
    if (!drag) return;
    this.drag = null;
    this.squash.to(0, 560, 13);
    this.y.to(this.restY(), 420, 9);
    if (drag.moved) {
      this.squash.kick(4);
      this.feel("happy", 900);
    } else if (event.type === "pointerup") {
      this.poke();
    }
  };

  /** A poke is a jelly squish; too many at once and Auni goes dizzy. */
  private poke(): void {
    this.lastNear = this.time;
    const next = poke(this.pokes, this.time);
    this.pokes = next.times;
    if (next.dizzy) {
      void this.play((turn) => this.dizzy(turn));
      return;
    }
    this.squash.kick(7);
    this.tilt.kick((Math.random() - 0.5) * 260);
    this.feel("happy", 700);
  }

  private async dizzy(turn: number): Promise<void> {
    this.held = { mood: "dizzy", until: Infinity };
    for (let index = 0; index < 7; index += 1) {
      const way = index % 2 ? -1 : 1;
      this.tilt.kick(way * 320);
      this.x.kick(way * 90 * this.scale);
      if (!(await this.beat(turn, 150))) return;
    }
    if (!(await this.beat(turn, 900))) return;
    // It shakes it off.
    this.shake(5, 10);
    this.squash.kick(3);
    await this.beat(turn, 400);
  }

  /** Chin down on its paws, eyes shut. */
  private doze(): void {
    this.asleep = true;
    this.nextZ = this.time + 1;
    this.y.to(placeY("eyes", this.size), 40, 12);
  }

  /** Woken with a start. */
  private wake(): void {
    this.asleep = false;
    this.lastNear = this.time;
    this.feel("up", 800);
    this.y.to(this.restY(), 420, 14);
    this.y.kick(-420 * this.scale);
    this.squash.kick(-3);
  }

  /** A soft z, rising from Auni as it sleeps. */
  private snore(): void {
    const z = document.createElement("span");
    z.className = this.parts.z;
    z.textContent = "z";
    this.parts.root.append(z);
    const x = this.x.x + this.size * 0.68;
    const y = this.y.x + this.size * 0.14;
    z.animate(
      [
        { transform: `translate(${px(x)}, ${px(y)}) scale(0.6)`, opacity: 0 },
        { opacity: 0.85, offset: 0.25 },
        {
          transform: `translate(${px(x + 16 * this.scale)}, ${px(y - 32 * this.scale)}) scale(1.1) rotate(-12deg)`,
          opacity: 0,
        },
      ],
      { duration: 2200, easing: "ease-out" },
    ).finished.then(
      () => z.remove(),
      () => z.remove(),
    );
  }
}

function flippedLast(): boolean {
  try {
    return localStorage.getItem(FLIP_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(flipped: boolean): void {
  try {
    localStorage.setItem(FLIP_KEY, flipped ? "1" : "0");
  } catch {
    // Storage blocked: the next finish may flip again, which is no harm.
  }
}

function px(value: number): string {
  return `${value.toFixed(2)}px`;
}

function deg(value: number): string {
  return `${value.toFixed(2)}deg`;
}
