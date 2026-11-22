"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { useComposerDraft } from "@/components/app/composer-drafts";
import { useStartConversation } from "@/components/app/use-start-conversation";
import { useOwner } from "@/components/auth/owner-provider";
import { Lockup } from "@/components/brand/lockup";
import { Sky } from "@/components/brand/sky";
import { BringWallet, WalletHome } from "@/components/first-run/bring-wallet";
import styles from "@/components/first-run/first-run.module.css";
import { useFirstRun } from "@/components/first-run/use-first-run";
import { noteWalletMade } from "@/components/first-run/wallet-made";
import { ME_KEY } from "@/components/personalization/use-me";
import { useBrains } from "@/lib/data/brains";
import { getMe } from "@/lib/data/me";
import { useSetup, useSetupStep } from "@/lib/data/setup";
import { carryTake, type Carry } from "@/lib/first-message";

import { BeliefStage } from "./belief-stage";
import { playLandingDive } from "./landing-dive";

/**
 * First run opens on the landing: Auni among takes people hold, and one question. It lives over
 * the app rather than in a page (PlaceWorkspace), so sending the first take can start its chat
 * underneath and dive straight in: it stays on screen while the chat opens, and leaves once the
 * app is all that's left. Nothing is asked before the take: the owner's AI and money are asked
 * for in the chat, when the take needs them. A quiet door at its foot brings an auni.io wallet.
 */
export function Landing() {
  const firstRun = useFirstRun();
  const [carrying, setCarrying] = useState(false);
  // A take that didn't reach Auni comes back to a landing drawn afresh, its words still there.
  const [tries, setTries] = useState(0);
  const carry = useCallback(() => setCarrying(true), []);
  const done = useCallback(() => setCarrying(false), []);
  const failed = useCallback(() => {
    setCarrying(false);
    setTries((count) => count + 1);
  }, []);
  if (!firstRun && !carrying) return null;
  return (
    <LandingPage key={tries} failed={tries > 0} onCarry={carry} onDone={done} onFailed={failed} />
  );
}

/** What first run shows while core says whose browser this is: the landing's sky, still empty. */
export function Waking() {
  return (
    <main id="main-content" className="auni-landing">
      <Sky />
      <LandingBar />
      <p role="status" className="sr-only">
        Waking up
      </p>
    </main>
  );
}

function LandingBar() {
  return (
    <header className="auni-landing-bar">
      <span className="auni-landing-wordmark">
        <Lockup height={20} priority />
      </span>
    </header>
  );
}

function LandingPage({
  failed,
  onCarry,
  onDone,
  onFailed,
}: {
  /** The last take sent didn't reach Auni. */
  readonly failed: boolean;
  /** The take is on its way into the app: the landing must outlive first run. */
  readonly onCarry: () => void;
  /** The dive has landed, or was abandoned. */
  readonly onDone: () => void;
  readonly onFailed: () => void;
}) {
  const pageRef = useRef<HTMLElement>(null);
  const [bringing, setBringing] = useState(false);
  // Back from the door, the landing is simply there again, with no entrance to replay.
  const [back, setBack] = useState(false);
  const [brought, setBrought] = useState(false);
  const [carry, setCarry] = useState<Carry | null>(null);
  const { start } = useStartConversation();
  const finish = useSetupStep();
  // Read now, so the door's private field is there the moment it opens; once a wallet is in, the
  // door has nothing left to bring.
  const walletIn = Boolean(useSetup().data?.wallet.addresses);
  // Kept fresh while they type, so the take knows as it's sent whether an AI can answer it.
  useBrains();
  const { setOwner } = useOwner();
  const queryClient = useQueryClient();
  const { clearForSend, message, setMessage } = useComposerDraft({
    draftKey: "new",
    initialMessage: "",
    interactive: true,
  });

  // Sending the take finishes first run (core makes the wallet, unless one was brought) and
  // starts Auni's chat with it, as any new chat starts, while the landing dives into it.
  const send = async (take: string) => {
    onCarry();
    const carried = carryTake();
    setCarry(carried);
    const me = await finish
      .mutateAsync({ path: "setup/done", body: {} })
      .then(getMe)
      .catch(() => null);
    if (!me) return onFailed();
    clearForSend();
    noteWalletMade(!walletIn);
    // In one render: the app opens underneath as the owner's, done with first run, and the chat
    // starts there, its first frame drawn for the dive to land in.
    queryClient.setQueryData(ME_KEY, me);
    setOwner(me);
    await start(take, carried.take);
  };

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!carry || !page) return;
    const dive = playLandingDive(page, carry.arrived);
    let live = true;
    void dive.finished.then(() => {
      if (live) onDone();
    });
    return () => {
      live = false;
      dive.cancel();
      // Landed or abandoned, the chat may move on.
      carry.land();
    };
  }, [carry, onDone]);

  return (
    <main
      ref={pageRef}
      id={carry ? undefined : "main-content"}
      className="auni-landing"
      data-diving={carry ? "" : undefined}
      data-back={back ? "" : undefined}
    >
      <Sky />
      <p className="sr-only" role="status">
        {carry ? "Starting your chat." : ""}
      </p>
      <LandingBar />
      {bringing ? (
        <BringWallet
          onDone={(home) => {
            setBringing(false);
            setBack(true);
            setBrought(home);
          }}
        />
      ) : (
        <>
          <BeliefStage
            value={message}
            onChange={setMessage}
            inert={carry !== null}
            under={
              failed ? (
                <span className="text-destructive">
                  That didn&apos;t reach Auni. Your words are still here, so try again.
                </span>
              ) : (
                "Tell Auni. It digs in with your own AI and shows you how it would play it."
              )
            }
            onSubmit={(take) => void send(take)}
          />
          <footer className="auni-landing-footer" inert={carry !== null}>
            {brought ? (
              <WalletHome />
            ) : walletIn ? null : (
              <button type="button" className={styles.door} onClick={() => setBringing(true)}>
                Had Auni at auni.io?
              </button>
            )}
          </footer>
        </>
      )}
    </main>
  );
}
