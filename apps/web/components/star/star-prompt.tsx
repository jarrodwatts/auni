"use client";

import "./star-prompt.css";

import { AUNI_REPO_URL } from "@auni/shared";
import { StarIcon } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { Mascot } from "@/components/brand/mascot";
import { useMe, useRefreshMe } from "@/components/personalization/use-me";
import { answerStarPrompt, checkStar, getMe, starOnGitHub } from "@/lib/data/me";
import { watchThreadRows } from "@/lib/data/threads";

// Asks the owner for a star on Auni's GitHub: once a move of theirs has landed (core's
// `starPrompt`), at most once a browser session, after 30 seconds without input in a focused
// window, and never again once they answer, on any device. Star, Not now and closing it all
// answer, and core keeps the answer. Core stars Auni in place with the owner's own GitHub CLI;
// when it can't, GitHub opens in a new tab.

const ID = "star-prompt";
const ASK = "Enjoying Auni?";
const IDLE_MS = 30_000;
const THANKS_MS = 5_000;
/** Kept while the tab lives, so a reload doesn't ask again. */
const ASKED_KEY = "auni:star-prompt:asked";
// What the owner's hand starts: a click or tap, a key, a scroll, coming back to the window.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "focus"] as const;

let askedThisSession = false;

function firstAskThisSession(): boolean {
  if (askedThisSession) return false;
  askedThisSession = true;
  try {
    if (sessionStorage.getItem(ASKED_KEY)) return false;
    sessionStorage.setItem(ASKED_KEY, "1");
  } catch {
    // Without the tab's storage a reload may ask once more; the answer is core's either way.
  }
  return true;
}

/** Resolves after IDLE_MS without input while this window has focus. */
function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Input in another app or a frame never reaches this page; the next focus starts again.
        if (!document.hasFocus() || document.activeElement?.matches("iframe")) return;
        for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, restart, true);
        resolve();
      }, IDLE_MS);
    };
    for (const type of ACTIVITY_EVENTS)
      window.addEventListener(type, restart, { capture: true, passive: true });
    restart();
  });
}

/**
 * Asks once this session, when the owner is idle, unless their GitHub account starred Auni
 * already (core records that as their answer) or they answered on another device meanwhile.
 */
export async function askForStarOnce(): Promise<void> {
  if (!firstAskThisSession()) return;
  // Core out of reach records nothing and asks nothing. A check gh couldn't make (null) still
  // asks: Star then opens GitHub.
  const starred = await checkStar().catch(() => undefined);
  if (starred !== false && starred !== null) return;
  await waitForIdle();
  if ((await getMe().catch(() => null))?.starPrompt !== "ask") return;
  toast(ASK, {
    id: ID,
    duration: Number.POSITIVE_INFINITY,
    className: "auni-star-toast",
    icon: <Mascot alt="" size={36} state="listening" />,
    description: "A star on GitHub helps other people find me.",
    action: <StarActions onStar={() => void star()} />,
    // Not now, a swipe and opening GitHub all close it through here, and each is an answer.
    onDismiss: () => void answerStarPrompt().catch(() => undefined),
  });
}

async function star() {
  toast(ASK, { id: ID, action: <StarActions starring /> });
  if (await starOnGitHub().catch(() => false)) return thank();
  // A browser opens a tab only while the tap that asked is fresh; after it, one more tap does.
  if (navigator.userActivation?.isActive !== false) return openGitHub();
  toast(ASK, { id: ID, action: <StarActions label="Open GitHub" onStar={openGitHub} /> });
}

function openGitHub() {
  window.open(AUNI_REPO_URL, "_blank", "noopener,noreferrer");
  toast.dismiss(ID);
}

/** Thanks them in the same card, which closes itself a moment later. */
function thank() {
  toast(
    <span className="auni-star-thanks">
      Thanks for the star!
      <StarIcon aria-hidden className="auni-star-pop" fill="currentColor" />
    </span>,
    {
      id: ID,
      duration: THANKS_MS,
      icon: <Mascot alt="" className="auni-star-hop" key="thanks" size={36} state="celebrating" />,
      description: "That helps more people find me.",
      action: undefined,
      classNames: { content: "auni-star-swap" },
    },
  );
}

function StarActions({
  onStar,
  starring = false,
  label = "Star on GitHub",
}: {
  readonly onStar?: () => void;
  readonly starring?: boolean;
  readonly label?: string;
}) {
  return (
    <div className="auni-star-actions">
      <button className="auni-star-not-now" onClick={() => toast.dismiss(ID)} type="button">
        Not now
      </button>
      <button data-button disabled={starring} onClick={onStar} type="button">
        <StarIcon aria-hidden className="size-3.5" strokeWidth={2.2} />
        {starring ? "Starring" : label}
      </button>
    </div>
  );
}

/**
 * Asks for a star once core says it's time (see askForStarOnce). Until a move lands, the owner is
 * read again whenever a chat's row changes, since a move that lands changes its chat's row: so
 * the first one asks in the session it lands in, not only at the next page load.
 */
export function StarPrompt() {
  const { starPrompt } = useMe();
  const refreshMe = useRefreshMe();
  useEffect(() => {
    if (starPrompt === "ask") void askForStarOnce();
    if (starPrompt !== "waiting") return;
    return watchThreadRows(refreshMe, () => {}, refreshMe);
  }, [starPrompt, refreshMe]);
  return null;
}
