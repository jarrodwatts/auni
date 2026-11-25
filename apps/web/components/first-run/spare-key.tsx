"use client";

import { Check } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

import { mustPairAgain } from "@/components/auth/pair-again";
import { Button } from "@/components/ui/button";
import { WalletKeyList } from "@/components/settings/wallet-keys-dialog";
import { CopyLine } from "@/components/ui/copy-line";
import { revealWalletKeys } from "@/lib/data/me";
import { noteTerminalTrip } from "@/lib/terminal-trip";
import { REDUCED_MOTION } from "@/lib/use-viewport";
import { useSetup, useSetupStep } from "@/lib/data/setup";

import styles from "./first-run.module.css";
import { NotLooking } from "./not-looking";

type Keys = Awaited<ReturnType<typeof revealWalletKeys>>;

type Stage =
  | { readonly kind: "offered" }
  | { readonly kind: "showing"; readonly keys: Keys }
  | { readonly kind: "pair-again" }
  | { readonly kind: "saved" };

/**
 * Save it was tapped and showing the keys took a fresh pairing: kept on the device, so the owner
 * back from `auni pair` sees the keys without tapping again, in this tab or the one its link
 * opens. A pairing link works for 15 minutes; a note older than that came to nothing.
 */
const ASKED_KEY = "auni:spare-key-asked";
const ASKED_MS = 20 * 60_000;

function noteAsked(asked: boolean): void {
  try {
    if (asked) localStorage.setItem(ASKED_KEY, String(Date.now()));
    else localStorage.removeItem(ASKED_KEY);
  } catch {
    // Blocked storage: the owner taps Save it again once back.
  }
}

function wasAsked(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(ASKED_KEY) ?? 0) < ASKED_MS;
  } catch {
    return false;
  }
}

/**
 * The spare key, offered in the chat once the wallet holds money and the owner is free (never
 * before, so first run asks nothing up front, and never while money is still landing or a card
 * waits on them; core's keyWorthSaving): Auni pulls it from under its cap, and turns its back
 * while the keys show. Showing them takes the owner's proof (core's auth/proof.ts), as Settings'
 * Wallet keys does. A browser that paired a while ago (likely, for an owner whose money came from
 * an exchange) gets Auni asking whether it's them, and `auni pair`; back from it, the keys show
 * without another tap. Whether it's due, saved or put off is core's (`GET /setup`), so Later
 * holds in every chat and every tab. The keys live only in this card's state, and go once the
 * owner says they saved them.
 */
export function SpareKey() {
  const setup = useSetup();
  const save = useSetupStep();
  const [stage, setStage] = useState<Stage>({ kind: "offered" });
  const [error, setError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  // The keys open under where the owner tapped: all of them come into view, down to I saved it.
  const card = useRef<HTMLElement>(null);
  const showing = stage.kind === "showing";
  // The button tapped is gone with the stage it was in: focus comes to the card's new title, or,
  // asked to pair again, to the command to copy.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (stage.kind === "showing") title.current?.focus({ preventScroll: true });
  }, [stage.kind]);
  useEffect(() => {
    if (!showing) return;
    const smooth = !matchMedia(REDUCED_MOTION).matches;
    card.current?.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
  }, [showing]);
  // Once saved, the keys fold to one line at the very end of the chat, which the chat scrolls to:
  // its follow would stop at the start of the owner's last message, leaving the line under the
  // reply box.
  const { scrollRef } = useStickToBottomContext();
  const saved = stage.kind === "saved";
  useEffect(() => {
    const chat = scrollRef.current;
    if (!saved || !chat) return;
    const smooth = !matchMedia(REDUCED_MOTION).matches;
    chat.scrollTo({ top: chat.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, [saved, scrollRef]);

  const later = async () => {
    try {
      await save.mutateAsync({ path: "setup/backup/later" });
    } catch {
      setError("That didn't reach me. Nothing changed, so try again.");
    }
  };

  const show = async () => {
    setRevealing(true);
    setError(null);
    try {
      const keys = await revealWalletKeys();
      noteAsked(false);
      setStage({ kind: "showing", keys });
    } catch (caught) {
      if (mustPairAgain(caught)) {
        noteAsked(true);
        // So the tab the pairing link opens comes back to this chat (lib/terminal-trip.ts).
        noteTerminalTrip(window.location.pathname + window.location.search);
        setStage({ kind: "pair-again" });
      } else setError("That didn't reach me. No keys were shown, so try again.");
    } finally {
      setRevealing(false);
    }
  };

  // Back from `auni pair`, in this tab or the one its link opened, the keys show as asked.
  const due = setup.data?.spareKey === "due";
  const carryOn = useEffectEvent(() => {
    if (due && stage.kind !== "showing" && !revealing && wasAsked()) void show();
  });
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") carryOn();
    };
    // Now, for the tab the pairing link opened; then each time the owner comes back to this one.
    const now = setTimeout(back);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      clearTimeout(now);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [due]);

  const facts = setup.data;
  if (!facts) return null;
  if (stage.kind === "offered" && facts.spareKey !== "due") return null;

  const keep = async () => {
    try {
      await save.mutateAsync({ path: "setup/backup" });
      setStage({ kind: "saved" });
    } catch {
      setError("That didn't reach me. Your keys are still here, so try again.");
    }
  };

  if (stage.kind === "saved")
    return (
      <p className={styles.keySaved} role="status">
        <Check aria-hidden className="size-4" />
        Saved. You can see your keys again any time in Settings.
      </p>
    );

  return (
    <section
      ref={card}
      className={styles.key}
      aria-label="Your spare key"
      data-showing={showing || undefined}
    >
      <NotLooking
        away={showing}
        pose="key"
        size={112}
        className={styles.keyAuni}
        {...(stage.kind === "pair-again" ? { asks: "Is that you?" } : {})}
      />
      <div className={styles.keyWords}>
        <h2 ref={title} tabIndex={-1} className={styles.keyTitle}>
          {showing
            ? "Your wallet keys"
            : stage.kind === "pair-again"
              ? "Confirm it's you"
              : "Your money's worth a spare key"}
        </h2>
        <p className={styles.keyLine}>
          {showing
            ? "Keep them with your passwords. Anyone who has them can move all your money."
            : stage.kind === "pair-again"
              ? "Run this in your terminal and open the link it prints. I'll show your keys right here."
              : "Let me show you your wallet's keys. If this computer is ever lost, they get your money back."}
        </p>
        {showing ? (
          <>
            <WalletKeyList keys={stage.keys} className="mt-4" />
            <Button
              size="lg"
              className="mt-4 w-full"
              disabled={save.isPending}
              aria-busy={save.isPending}
              onClick={() => void keep()}
            >
              {save.isPending ? "Saving" : "I've saved them"}
            </Button>
          </>
        ) : stage.kind === "pair-again" ? (
          <div role="status" aria-busy className="mt-4">
            <CopyLine value="auni pair" command focused />
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              disabled={save.isPending}
              onClick={() => void later()}
            >
              Later
            </Button>
            <Button
              size="lg"
              className="flex-1"
              disabled={revealing}
              aria-busy={revealing}
              onClick={() => void show()}
            >
              {revealing ? "Checking it's you" : "Show keys"}
            </Button>
          </div>
        )}
        {error ? (
          <p role="alert" className={styles.keyError}>
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
