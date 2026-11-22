"use client";

import { threadIdSchema, type ThreadId } from "@auni/shared";
import { useParams, usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";

import { useThreads } from "@/components/app/use-threads";
import { APPS_HREF } from "@/lib/app-links";
import type { Thread } from "@/lib/data/views";

import { chatStatus, type ChatStatus } from "./attention";

/** Where the person is: Portfolio, Activity, Apps, a new thread, or a thread. */
export type PlaceRoute =
  | { readonly kind: "portfolio" }
  | { readonly kind: "activity" }
  | { readonly kind: "apps" }
  | { readonly kind: "new" }
  | { readonly kind: "chat"; readonly id: ThreadId };

export function usePlaceRoute(): PlaceRoute {
  const pathname = usePathname();
  const params = useParams<{ thread?: string }>();
  const chat = threadIdSchema.safeParse(params.thread);
  if (chat.success) return { kind: "chat", id: chat.data };
  if (pathname === "/app/activity") return { kind: "activity" };
  if (pathname === APPS_HREF) return { kind: "apps" };
  return pathname === "/app/new" ? { kind: "new" } : { kind: "portfolio" };
}

/** One thread as the sidebar, Portfolio, and search display it. */
export interface ChatPlace {
  readonly thread: Thread;
  /** A card in it waits on the person. */
  readonly waiting: boolean;
  readonly status: ChatStatus;
}

const MINUTE_MS = 60_000;

function subscribeToMinutes(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, MINUTE_MS);
  return () => window.clearInterval(timer);
}

function readMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** The time to the minute, for anything that reads "how long ago". */
export function useMinute(): number {
  return useSyncExternalStore(subscribeToMinutes, readMinute, readMinute);
}

/** Whether a thread belongs in the Active group (watching, Auto budget, running, or waiting). */
function isActiveThread(thread: Thread): boolean {
  return (
    thread.state === "needs_user" ||
    thread.state === "running" ||
    thread.actMode === "within_limits" ||
    thread.watchCount > 0
  );
}

/**
 * All threads organized for the sidebar, Portfolio, and search:
 * - pinned: pinned threads, newest pinned first
 * - active: unpinned threads that are waiting, running, watching, or in Auto mode
 * - recent: remaining unarchived threads, newest first
 * - archived: archived threads without waiting cards (found by search)
 */
export function usePlaces() {
  const { threads } = useThreads();
  const route = usePlaceRoute();
  const here = route.kind === "chat" ? route.id : null;

  return useMemo(() => {
    const waiting = new Map<ThreadId, Thread>();
    const listed = threads.filter(({ archived, state }) => !archived || state === "needs_user");
    for (const thread of listed)
      if (thread.state === "needs_user" && thread.id !== here) waiting.set(thread.id, thread);

    const toPlace = (thread: Thread): ChatPlace => ({
      thread,
      waiting: waiting.has(thread.id),
      status: chatStatus(thread),
    });
    const newestFirst = (a: Thread, b: Thread) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

    const chats = listed.toSorted(newestFirst).map(toPlace);
    const pinned = listed
      .filter((thread) => thread.pinned)
      .toSorted(
        (a, b) =>
          Date.parse(b.pinnedAt ?? b.updatedAt) - Date.parse(a.pinnedAt ?? a.updatedAt),
      )
      .map(toPlace);
    const active = listed
      .filter((thread) => !thread.pinned && isActiveThread(thread))
      .toSorted(newestFirst)
      .map(toPlace);
    const recent = listed
      .filter((thread) => !thread.pinned && !isActiveThread(thread))
      .toSorted(newestFirst)
      .map(toPlace);
    const archived = threads
      .filter((thread) => !listed.includes(thread))
      .toSorted(newestFirst)
      .map(toPlace);

    return {
      chats,
      pinned,
      active,
      recent,
      archived,
      waiting,
      waitingCount: chats.filter((place) => place.waiting).length,
    };
  }, [threads, here]);
}
