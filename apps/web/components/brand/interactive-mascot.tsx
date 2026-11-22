"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent, Ref } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";

import { gaze } from "@/components/brand/gaze";
import { MascotArt } from "@/components/brand/mascot-art";
import { cn } from "@/lib/utils";

const CLICK_REACTIONS = ["celebrating", "executing"] as const;
const REACTION_DURATION_MS = 1_050;
const SPARKS = [
  { x: -54, y: -46 },
  { x: 0, y: -66 },
  { x: 55, y: -42 },
  { x: 68, y: 5 },
  { x: 38, y: 58 },
  { x: -61, y: 20 },
] as const;

type ClickReaction = (typeof CLICK_REACTIONS)[number];
type SparkStyle = CSSProperties & {
  "--auni-spark-delay": string;
  "--auni-spark-x": string;
  "--auni-spark-y": string;
};

export type MascotReadingTarget =
  { readonly active: false } | { readonly active: true; readonly x: number; readonly y: number };

export interface InteractiveMascotHandle {
  readonly trackCaret: (target: MascotReadingTarget) => void;
}

function sparkStyle(x: number, y: number, index: number): SparkStyle {
  return {
    "--auni-spark-delay": `${index * 45}ms`,
    "--auni-spark-x": `${x}px`,
    "--auni-spark-y": `${y}px`,
  };
}

/** Leans Auni toward a point on screen; the eyes reach further than the body. */
function lookAt(
  root: HTMLElement,
  targetX: number,
  targetY: number,
  eyeReach: readonly [number, number],
) {
  const bounds = root.getBoundingClientRect();
  const deltaX = targetX - (bounds.left + bounds.width / 2);
  const deltaY = targetY - (bounds.top + bounds.height / 2);
  const toward = gaze(deltaX, deltaY, 240);
  const px = (value: number) => `${value.toFixed(2)}px`;

  root.style.setProperty("--auni-track-x", px(toward.x * 5));
  root.style.setProperty("--auni-track-y", px(toward.y * 4));
  root.style.setProperty(
    "--auni-track-rotate",
    `${Math.max(-3.5, Math.min(3.5, deltaX / 105)).toFixed(2)}deg`,
  );
  root.style.setProperty("--auni-eye-x", px(toward.x * eyeReach[0]));
  root.style.setProperty("--auni-eye-y", px(toward.y * eyeReach[1]));
}

function resetTrackingPose(root: HTMLElement) {
  root.style.setProperty("--auni-track-x", "0px");
  root.style.setProperty("--auni-track-y", "0px");
  root.style.setProperty("--auni-track-rotate", "0deg");
  root.style.setProperty("--auni-eye-x", "0px");
  root.style.setProperty("--auni-eye-y", "0px");
}

interface InteractiveMascotProps {
  readonly className?: string;
  readonly ref?: Ref<InteractiveMascotHandle>;
  readonly size?: number;
  /**
   * Asleep, its eyes shut and its breath slow, until it isn't: then it wakes with a start and
   * looks about as it always does.
   */
  readonly asleep?: boolean;
  /**
   * Out of the keyboard's way, where it only watches over a page whose keys go somewhere else
   * (first run's question): a pointer can still play with it.
   */
  readonly unfocusable?: boolean;
}

/** How long waking up takes, from the jolt to settling. */
const WAKING_MS = 900;

export function InteractiveMascot({
  className,
  ref,
  size = 116,
  asleep = false,
  unfocusable = false,
}: InteractiveMascotProps) {
  const rootRef = useRef<HTMLButtonElement>(null);
  const readingRef = useRef(false);
  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reactionIndexRef = useRef(0);
  const [engaged, setEngaged] = useState(false);
  const [reaction, setReaction] = useState<ClickReaction | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Woken a moment ago: what's drawn while it wakes up.
  const [wasAsleep, setWasAsleep] = useState(asleep);
  const [waking, setWaking] = useState(false);
  if (wasAsleep !== asleep) {
    setWasAsleep(asleep);
    setWaking(!asleep);
  }
  useEffect(() => {
    if (!waking) return undefined;
    const settle = setTimeout(() => setWaking(false), WAKING_MS);
    return () => clearTimeout(settle);
  }, [waking]);
  const sleepingRef = useRef(asleep);
  useEffect(() => {
    sleepingRef.current = asleep;
  }, [asleep]);

  const state = reaction ?? (engaged ? "thinking" : "listening");

  useImperativeHandle(
    ref,
    () => ({
      trackCaret(target) {
        const root = rootRef.current;
        if (!root) return;

        readingRef.current = target.active;
        root.dataset.reading = target.active ? "true" : "false";

        if (
          sleepingRef.current ||
          !target.active ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          resetTrackingPose(root);
          return;
        }

        lookAt(root, target.x, target.y, [15, 11]);
      },
    }),
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const finePointer = window.matchMedia("(pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame: number | null = null;
    let pointerX = 0;
    let pointerY = 0;

    const applyPose = () => {
      animationFrame = null;
      if (readingRef.current) return;
      // Asleep, it looks at nothing.
      if (sleepingRef.current || !finePointer.matches || reducedMotion.matches) {
        resetTrackingPose(root);
        return;
      }

      lookAt(root, pointerX, pointerY, [12, 8]);
    };

    const trackPointer = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(applyPose);
    };

    const handleCapabilityChange = () => resetTrackingPose(root);
    const leave = () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      if (!readingRef.current) resetTrackingPose(root);
    };

    window.addEventListener("pointermove", trackPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    finePointer.addEventListener("change", handleCapabilityChange);
    reducedMotion.addEventListener("change", handleCapabilityChange);

    return () => {
      window.removeEventListener("pointermove", trackPointer);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      finePointer.removeEventListener("change", handleCapabilityChange);
      reducedMotion.removeEventListener("change", handleCapabilityChange);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(
    () => () => {
      if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    },
    [],
  );

  const react = () => {
    const nextReaction = CLICK_REACTIONS[
      reactionIndexRef.current % CLICK_REACTIONS.length
    ] as ClickReaction;
    reactionIndexRef.current += 1;

    if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    setReaction(nextReaction);
    setAnnouncement(
      nextReaction === "celebrating" ? "Auni is celebrating" : "Auni is ready to work",
    );
    reactionTimerRef.current = setTimeout(() => {
      setReaction(null);
      reactionTimerRef.current = null;
    }, REACTION_DURATION_MS);
  };

  const engagePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "touch") setEngaged(true);
  };

  return (
    <button
      ref={rootRef}
      type="button"
      aria-label="Play with Auni"
      aria-hidden={unfocusable || undefined}
      tabIndex={unfocusable ? -1 : undefined}
      className={cn("auni-interactive-mascot relative block shrink-0", className)}
      data-state={state}
      data-asleep={asleep || undefined}
      data-waking={waking || undefined}
      style={{ "--auni-mascot-size": `${size}px` } as CSSProperties}
      onBlur={() => setEngaged(false)}
      onClick={react}
      onFocus={() => setEngaged(true)}
      onPointerEnter={engagePointer}
      onPointerLeave={() => setEngaged(false)}
    >
      {/*
       * The glow reaches 44% past the mascot on every side and fades to nothing
       * long before its edge, so on a phone it lies invisibly over the headline
       * underneath. Decoration must not answer a tap that belongs to the words.
       */}
      <span
        aria-hidden
        className="auni-mascot-glow pointer-events-none absolute inset-[-44%] rounded-full"
      />
      <span aria-hidden className="auni-mascot-tracker absolute inset-0">
        <span className="auni-mascot-press absolute inset-0">
          <span className="auni-mascot-body absolute inset-0">
            <span className="auni-mascot-notice absolute inset-0">
              <MascotArt moods />
            </span>
          </span>
        </span>

        {asleep ? (
          <span className="auni-mascot-zzz absolute inset-0">
            <span>z</span>
            <span>z</span>
            <span>z</span>
          </span>
        ) : null}

        <span className="auni-mascot-sparks absolute inset-0">
          {SPARKS.map(({ x, y }, index) => (
            <span
              key={`${x}-${y}`}
              className="auni-mascot-spark absolute top-1/2 left-1/2"
              style={sparkStyle(x, y, index)}
            />
          ))}
        </span>
      </span>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </button>
  );
}
