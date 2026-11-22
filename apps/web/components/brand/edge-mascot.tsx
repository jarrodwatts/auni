"use client";

import { useEffectEvent, useLayoutEffect, useRef, type CSSProperties } from "react";

import { useMediaQuery } from "@/lib/use-viewport";

import styles from "./edge-mascot.module.css";
import type { EdgeScene } from "./edge-pose";
import { EdgeRig } from "./edge-rig";
import { MascotArt, MascotCap } from "./mascot-art";

/** How tall Auni is over a card's edge, in px. */
export const EDGE_SIZE = 60;
/** How much of Auni must be in view for it to show over the card. */
const WHOLE = 0.95;

/**
 * Auni peeking over the top edge of a money card, keeping it company: body
 * behind the card, paws over its edge. It reacts to what the card is doing
 * and to the person's pointer, and moves only while the card is on screen.
 * It is decoration: everything it shows, the card says too.
 */
export function EdgeMascot({
  card,
  scene,
}: {
  /** The card it's on, measured and looked about. */
  readonly card: HTMLElement;
  readonly scene: EdgeScene;
}) {
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const cap = useRef<HTMLDivElement>(null);
  const contact = useRef<HTMLSpanElement>(null);
  const hit = useRef<HTMLSpanElement>(null);
  const left = useRef<HTMLSpanElement>(null);
  const right = useRef<HTMLSpanElement>(null);
  const rig = useRef<EdgeRig | null>(null);
  const show = useEffectEvent(() => rig.current?.show(scene));

  useLayoutEffect(() => {
    if (
      !root.current ||
      !body.current ||
      !cap.current ||
      !contact.current ||
      !hit.current ||
      !left.current ||
      !right.current
    ) {
      return undefined;
    }
    const auni = new EdgeRig(
      {
        root: root.current,
        body: body.current,
        cap: cap.current,
        contact: contact.current,
        hit: hit.current,
        paws: [left.current, right.current],
        card,
        z: styles.z ?? "",
      },
      EDGE_SIZE,
      still,
    );
    rig.current = auni;
    show();
    const sized = new ResizeObserver(() => auni.layout(card.offsetWidth));
    sized.observe(card);
    // Off screen, nothing of it moves.
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) auni.resume();
      else auni.pause();
    });
    seen.observe(card);
    // Scrolled up under the header, only a sliver of Auni would show over the card: it ducks
    // out of sight until all of it can show again.
    const tucked = root.current;
    const whole = new IntersectionObserver(
      ([entry]) => tucked.toggleAttribute("data-tucked", (entry?.intersectionRatio ?? 1) < WHOLE),
      { threshold: [WHOLE] },
    );
    whole.observe(body.current);
    return () => {
      sized.disconnect();
      seen.disconnect();
      whole.disconnect();
      auni.destroy();
      rig.current = null;
    };
  }, [card, still]);

  // A scene is a new object each render; Auni reacts only when what it says changes.
  const key =
    scene.kind === "running" || scene.kind === "attention"
      ? `${scene.kind}:${scene.row}`
      : scene.kind;
  useLayoutEffect(() => show(), [key]);

  return (
    <div
      ref={root}
      aria-hidden
      className={styles.edge}
      style={{ "--edge-size": `${EDGE_SIZE}px` } as CSSProperties}
    >
      <div ref={body} className={styles.body}>
        <MascotArt joy moods />
      </div>
      <span ref={contact} className={styles.contact} />
      <span ref={left} className={styles.paw} />
      <span ref={right} className={styles.paw} />
      <div ref={cap} className={styles.cap}>
        <MascotCap />
      </div>
      <span ref={hit} className={styles.hit} />
    </div>
  );
}
