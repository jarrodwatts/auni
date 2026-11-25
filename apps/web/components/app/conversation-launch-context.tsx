"use client";

import type { ThreadId } from "@auni/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Thread } from "@/lib/data/views";
import type { CarriedTake } from "@/lib/first-message";
import { reducedMotion } from "@/lib/motion";

const COMPOSER_FLIP_HOLD_MS = 340;
const HANDOFF_DURATION_MS = 140;
const CANCEL_DURATION_MS = 140;

type ConversationLaunchPhase = "creating" | "navigating" | "settled" | "cancelled";

interface ConversationLaunch {
  readonly id: string;
  readonly messageId: string;
  readonly phase: ConversationLaunchPhase;
  readonly prompt: string;
  readonly startedAt: number;
  /** Viewport Y of the centered hero composer on `/app/new`, for the FLIP glide into the dock. */
  readonly composerFromTop: number | null;
  /** Where Auni placed it, once it has. */
  readonly thread: Thread | null;
  /** The owner's first take, flown in from the landing, which draws its entrance. */
  readonly carried: CarriedTake | null;
}

interface ConversationLaunchContextValue {
  readonly launch: ConversationLaunch | null;
  readonly begin: (
    prompt: string,
    messageId: string,
    carried?: CarriedTake,
    composerFromTop?: number | null,
  ) => ConversationLaunch | null;
  readonly cancel: (launchId: string) => void;
  /** The place is known: its thread, which the stage's header now names. */
  readonly continueToThread: (launchId: string, thread: Thread) => void;
  readonly settle: (threadId: ThreadId) => void;
}

const ConversationLaunchContext = createContext<ConversationLaunchContextValue | null>(null);

export function useConversationLaunch(): ConversationLaunchContextValue {
  const value = useContext(ConversationLaunchContext);
  if (!value) {
    throw new Error("useConversationLaunch must be used inside ConversationLaunchProvider");
  }
  return value;
}

/** Keeps the first prompt alive while the App Router swaps conversation pages. */
export function ConversationLaunchProvider({ children }: { readonly children: ReactNode }) {
  const [launch, setLaunch] = useState<ConversationLaunch | null>(null);
  const launchRef = useRef<ConversationLaunch | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  const replaceLaunch = useCallback((next: ConversationLaunch | null) => {
    launchRef.current = next;
    setLaunch(next);
  }, []);

  const begin = useCallback(
    (
      prompt: string,
      messageId: string,
      carried?: CarriedTake,
      composerFromTop: number | null = null,
    ) => {
      const content = prompt.trim();
      if (!content || launchRef.current) return null;

      const next: ConversationLaunch = {
        id: crypto.randomUUID(),
        messageId,
        phase: "creating",
        prompt: content,
        startedAt: Date.now(),
        composerFromTop: carried ? null : composerFromTop,
        thread: null,
        carried: carried ?? null,
      };
      replaceLaunch(next);
      return next;
    },
    [replaceLaunch],
  );

  const continueToThread = useCallback(
    (launchId: string, thread: Thread) => {
      const current = launchRef.current;
      if (!current || current.id !== launchId) return;
      replaceLaunch({ ...current, phase: "navigating", thread });
    },
    [replaceLaunch],
  );

  const cancel = useCallback(
    (launchId: string) => {
      const current = launchRef.current;
      if (!current || current.id !== launchId) return;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      replaceLaunch({ ...current, phase: "cancelled" });
    },
    [replaceLaunch],
  );

  const settle = useCallback(
    (threadId: ThreadId) => {
      const current = launchRef.current;
      if (!current || current.thread?.id !== threadId || current.phase === "settled") return;

      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }

      const holdMs =
        current.composerFromTop !== null && !current.carried && !reducedMotion()
          ? Math.max(0, COMPOSER_FLIP_HOLD_MS - (Date.now() - current.startedAt))
          : 0;

      if (holdMs === 0) {
        replaceLaunch({ ...current, phase: "settled" });
        return;
      }
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        const active = launchRef.current;
        if (!active || active.thread?.id !== threadId) return;
        replaceLaunch({ ...active, phase: "settled" });
      }, holdMs);
    },
    [replaceLaunch],
  );

  useEffect(() => {
    if (launch?.phase !== "settled" && launch?.phase !== "cancelled") return;
    const duration = launch.phase === "settled" ? HANDOFF_DURATION_MS : CANCEL_DURATION_MS;
    const launchId = launch.id;
    const timer = window.setTimeout(() => {
      if (launchRef.current?.id === launchId) replaceLaunch(null);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [launch, replaceLaunch]);

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const value = useMemo<ConversationLaunchContextValue>(
    () => ({ begin, cancel, continueToThread, launch, settle }),
    [begin, cancel, continueToThread, launch, settle],
  );

  return <ConversationLaunchContext value={value}>{children}</ConversationLaunchContext>;
}
