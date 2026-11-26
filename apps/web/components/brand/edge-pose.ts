/**
 * Auni over a money card's top edge: what the card's state means for where
 * it sits and the face it pulls, the moments worth reacting to, and the small
 * sums its body follows. Nothing here touches the page; the mascot reads it.
 */

/** What the card under Auni is doing, from the card's own state. */
export type EdgeScene =
  /** Waiting on money to come in, before the person's tap can start it. */
  | { readonly kind: "funding" }
  /** Waiting on the person's tap. */
  | { readonly kind: "ready" }
  /** Its money is moving; `row` is the row happening now. */
  | { readonly kind: "running"; readonly row: string | null }
  /**
   * A row didn't go through, or waits on the person; null is the card's own
   * retry. `settled` once the card's money has stopped moving and only the
   * person trying again would start it.
   */
  | { readonly kind: "attention"; readonly row: string | null; readonly settled: boolean }
  /** Everything went through. */
  | { readonly kind: "landed" }
  /** It didn't go through, and there is nothing to do about it here. */
  | { readonly kind: "failed" };

export type Mood = "calm" | "work" | "up" | "worried" | "sad" | "happy" | "sleep" | "dizzy";

/** How high Auni sits over the edge. */
export type Place = "peek" | "up" | "eyes" | "hidden" | "sit";

interface Pose {
  readonly place: Place;
  readonly mood: Mood;
  /** Paws over the edge, holding on; sitting on top, it lets go. */
  readonly grip: boolean;
}

/**
 * Where Auni rests in each scene, between the moments it reacts. It rests in view only while the
 * card waits on the owner: for their tap, money to land, or a row only they can sort out. Once
 * they tap it ducks behind the card while the money moves, and after cheering a landing (or
 * slumping at a failure) it sinks out of sight: a card that needs nothing more is left alone.
 */
export function restPose(scene: EdgeScene): Pose {
  switch (scene.kind) {
    case "funding":
    case "ready":
      return { place: "peek", mood: "calm", grip: true };
    case "attention":
      return { place: "up", mood: "worried", grip: true };
    case "running":
      return { place: "hidden", mood: "work", grip: false };
    case "landed":
      return { place: "hidden", mood: "happy", grip: false };
    case "failed":
      return { place: "hidden", mood: "sad", grip: false };
  }
}

/**
 * The moments Auni reacts to as the card moves on: the money it waited on
 * coming in, the tap that starts it, each new row, a row that needs the
 * person, a failed row tried again, and how it ends.
 */
export type Cue = "funded" | "start" | "next" | "worry" | "retried" | "finish" | "slump";

export function edgeCue(from: EdgeScene | null, to: EdgeScene): Cue | null {
  // Arriving on a card, Auni simply comes up to its pose.
  if (from === null) return null;
  switch (to.kind) {
    case "funding":
      return null;
    case "ready":
      return from.kind === "funding" ? "funded" : null;
    case "running":
      if (from.kind === "ready" || from.kind === "funding") return "start";
      // The row that needed the person is under way again.
      if (from.kind === "attention" && from.row === to.row) return "retried";
      return from.kind === "running" && from.row !== to.row && to.row !== null ? "next" : null;
    case "attention":
      return from.kind === "attention" && from.row === to.row ? null : "worry";
    case "landed":
      return from.kind === "landed" ? null : "finish";
    case "failed":
      return from.kind === "failed" ? null : "slump";
  }
}

/**
 * How a card wants Auni, from the state it was first seen in and the one it's
 * in now. A card first seen with money still to move is one Auni comes to.
 * Once its money stops moving it only keeps Auni while it has it, so a card
 * Auni left for a newer one never calls it back. A card already settled when
 * it appears is history: Auni leaves it be.
 */
export function wantsAuni(first: EdgeScene, now: EdgeScene | null): "come" | "keep" | null {
  if (settled(first) || now === null) return null;
  return settled(now) ? "keep" : "come";
}

function settled(scene: EdgeScene): boolean {
  return (
    scene.kind === "landed" ||
    scene.kind === "failed" ||
    (scene.kind === "attention" && scene.settled)
  );
}

/** Where things are in the artwork, as fractions of its square. */
const ART = {
  top: 36 / 256,
  eyes: 118 / 256,
  eyesLow: 133 / 256,
  foot: 226 / 256,
} as const;

/** Where Auni's eyes are in its box, as fractions of its size: between the two. */
export const EYES = { x: 134 / 256, y: ART.eyes } as const;

/**
 * Where the top of Auni's box sits at each place, in px from the card's top
 * edge (above is negative), for Auni `size` px tall.
 */
export function placeY(place: Place, size: number): number {
  switch (place) {
    // Eyes just over the edge.
    case "peek":
      return -ART.eyesLow * size - 6;
    // Pulled up, chin clear of the edge.
    case "up":
      return -ART.eyesLow * size - 6 - size * 0.2;
    // Only the top of its eyes showing; where it dozes, chin on its paws.
    case "eyes":
      return -ART.eyes * size - 3;
    // Out of sight behind the card.
    case "hidden":
      return -ART.top * size + 6;
    // On top of the edge, its bottom just behind it.
    case "sit":
      return -ART.foot * size + 3;
  }
}

/** The most room Auni takes over the card's edge at rest, so the card can keep that clear. */
export function headroom(size: number): number {
  return Math.ceil(-placeY("sit", size) - ART.top * size);
}

/**
 * How Auni's body stretches as it moves up or down (`speed` in its own
 * heights a second, up is negative), squashes from a push, and breathes,
 * keeping its area: taller is always thinner.
 */
export function bodyScale(
  speed: number,
  squash: number,
  breath: number,
): { readonly x: number; readonly y: number } {
  const stretch = clamp(1 - speed * 0.036, 0.8, 1.24);
  const y = clamp(stretch * (1 - squash) * (1 + breath), 0.55, 1.6);
  return { x: 1 / y, y };
}

/** Pulled up `dragged` px, Auni gives less the further it goes, like rubber, up to most of its height. */
export function rubber(dragged: number, size: number): number {
  if (dragged <= 0) return 0;
  return (1 - 1 / (1 + dragged / (size * 1.05))) * size * 0.8;
}

/** Pokes this close together count toward making Auni dizzy. */
const POKE_WINDOW_S = 2.4;
const DIZZY_AFTER = 5;

/** A poke at `now` seconds: the recent ones it counts with, and whether that was one too many. */
export function poke(
  times: readonly number[],
  now: number,
): { readonly times: readonly number[]; readonly dizzy: boolean } {
  const recent = [...times.filter((time) => now - time < POKE_WINDOW_S), now];
  return recent.length >= DIZZY_AFTER
    ? { times: [], dizzy: true }
    : { times: recent, dizzy: false };
}

/** About one finish in seven, the cap flies off; never twice running on one device. */
export function flipsCap(roll: number, flippedLast: boolean): boolean {
  return !flippedLast && roll < 1 / 7;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
