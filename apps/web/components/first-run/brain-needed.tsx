"use client";

import { useEffect, useEffectEvent, useRef } from "react";

import { AppMark } from "@/components/apps/app-mark";
import { BrainRow } from "@/components/brains/brain-row";
import { MascotArt } from "@/components/brand/mascot-art";
import { useBrains, useBrainsSeen } from "@/lib/data/brains";

import { nothingThinks, readyBrain } from "./first-run";
import styles from "./first-run.module.css";

/** How long "Now I can think" shows before the take goes again. */
const CARRY_ON_MS = 1_400;

/**
 * An answer that only says no AI could think yet (core's `noBrain`), drawn as Auni asking for
 * one: an empty thought over its head, and the owner's AIs, each made ready from here (install
 * it, or its own sign-in). The moment one is, its mark fills the thought and the message goes
 * again in its own place, so the take carries on as if nothing had been in the way.
 */
export function BrainNeeded({
  latest,
  onReady,
}: {
  /** Only the newest such answer asks; an older one is history, its text enough. */
  readonly latest: boolean;
  readonly onReady: () => void;
}) {
  const rows = useBrains().data?.rows ?? [];
  const ready = readyBrain(rows);
  const carried = useRef(false);
  const carryOn = useEffectEvent(() => {
    carried.current = true;
    onReady();
  });
  const thinking = ready !== null;
  useEffect(() => {
    if (!latest || !thinking || carried.current) return undefined;
    const carry = setTimeout(carryOn, CARRY_ON_MS);
    return () => clearTimeout(carry);
  }, [latest, thinking]);

  return (
    <section
      className={styles.brain}
      data-ready={ready ? "" : undefined}
      data-take-lands
      aria-live="polite"
    >
      <div className={styles.brainStage} aria-hidden>
        <svg className={styles.thought} viewBox="0 0 220 140" fill="none">
          <path d="M60 112C30 112 14 94 18 74C21 58 35 48 50 50C52 28 72 14 94 18C106 6 132 4 146 18C164 10 190 20 194 44C212 50 216 74 204 88C200 104 182 114 164 110C152 122 126 124 112 114C98 120 74 120 60 112Z" />
          <circle cx="44" cy="126" r="7" />
          <circle cx="26" cy="136" r="3.5" />
        </svg>
        {ready ? (
          <span className={styles.thoughtMark}>
            <AppMark id={ready.id} name={ready.name} size={44} />
          </span>
        ) : null}
        <span className={styles.brainAuni}>
          <MascotArt moods joy />
        </span>
      </div>
      <div className={styles.brainWords}>
        {ready ? (
          <h2 className={styles.brainTitle}>Now I can think with {ready.name}</h2>
        ) : (
          <>
            <h2 className={styles.brainTitle}>Lend me a brain?</h2>
            <p className={styles.brainLine}>
              Sign in your AI on this computer and I&apos;ll pick your take straight back up.
            </p>
            <ul className={styles.brainRows}>
              {rows.map((item) => (
                <BrainRow key={item.row.id} item={item} machine="this computer" />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Whether a message sent now can only be answered by Auni asking for an AI, as far as the brains
 * were last read: then the answer to come is drawn as that ask from the send, rather than steps
 * that can't happen.
 */
export function useNoBrainYet(): boolean {
  return nothingThinks(useBrainsSeen());
}
