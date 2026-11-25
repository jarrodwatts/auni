"use client";

import { threadIdSchema, type ThreadId } from "@auni/shared";
import { useParams, usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";

import { useThreads } from "@/components/app/use-threads";
import { APPS_HREF, CHATS_HREF, NEEDS_YOU_HREF } from "@/lib/app-links";
import type { Thread } from "@/lib/data/views";

import { attentionOf, chatStatus, type ChatStatus } from "./attention";
import { useTakeValues, type TakeValue } from "./use-takes";

/** Where the person is: Money, Activity, Apps, Needs you, Chats, a new take, or a thread. */
export type PlaceRoute =
  | { readonly kind: "portfolio" }
  | { readonly kind: "activity" }
  | { readonly kind: "apps" }
  | { readonly kind: "needs-you" }
  | { readonly kind: "chats" }
  | { readonly kind: "new" }
  | { readonly kind: "chat"; readonly id: ThreadId };

const PATHS: Readonly<Record<string, PlaceRoute>> = {
  "/app/activity": { kind: "activity" },
  [APPS_HREF]: { kind: "apps" },
  [NEEDS_YOU_HREF]: { kind: "needs-you" },
  [CHATS_HREF]: { kind: "chats" },
  "/app/new": { kind: "new" },
};

export function usePlaceRoute(): PlaceRoute {
  const pathname = usePathname();
  const params = useParams<{ thread?: string }>();
  const chat = threadIdSchema.safeParse(params.thread);
  if (chat.success) return { kind: "chat", id: chat.data };
  return PATHS[pathname] ?? { kind: "portfolio" };
}

/** One thread as the sidebar, Money, and search display it. */
export interface ChatPlace {
  readonly thread: Thread;
  /** A card or a question in it waits on the person. */
  readonly waiting: boolean;
  readonly status: ChatStatus;
  /** A take's worth and its day; null for a chat that holds nothing, a closed take among them. */
  readonly take: TakeValue | null;
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

const newestFirst = (a: Thread, b: Thread) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
const pinnedFirst = (a: Thread, b: Thread) =>
  Number(b.pinned) - Number(a.pinned) ||
  Date.parse(b.pinnedAt ?? "0") - Date.parse(a.pinnedAt ?? "0");

/**
 * Every thread, sorted into the places it shows: each once, in the first that fits.
 * - needsYou: a card or a question waits on the person, newest first
 * - takes: `GET /takes` lists it (see useTakeValues), pinned first, then newest, so a row never
 *   moves as prices tick
 * - others: every other chat, a closed take among them as Money drops it, pinned first, then newest
 * - archived: put away, with nothing waiting (search finds them)
 * Until the takes are read, a chat that has moved money waits out of both lists rather than show
 * in one and jump to the other; one that never moved money is a chat already.
 * `chats` is every listed thread, newest first.
 */
export function placesOf(
  threads: readonly Thread[],
  takes: ReadonlyMap<ThreadId, TakeValue> | undefined,
) {
  const toPlace = (thread: Thread): ChatPlace => ({
    thread,
    waiting: attentionOf(thread) === "waiting",
    status: chatStatus(thread),
    take: takes?.get(thread.id) ?? null,
  });
  const all = threads.toSorted(newestFirst).map(toPlace);
  const listed = all.filter(({ thread, waiting }) => !thread.archived || waiting);
  const needsYou = listed.filter(({ waiting }) => waiting);
  const placed = listed.filter(
    ({ thread, waiting }) => !waiting && (takes !== undefined || thread.moveCount === 0),
  );
  return {
    chats: listed,
    needsYou,
    takes: placed
      .filter(({ take }) => take !== null)
      .toSorted((a, b) => pinnedFirst(a.thread, b.thread)),
    others: placed
      .filter(({ take }) => take === null)
      .toSorted((a, b) => pinnedFirst(a.thread, b.thread)),
    archived: all.filter((place) => !listed.includes(place)),
    waitingCount: needsYou.length,
  };
}

/** Every thread, sorted into its place, as the sidebar, Money, and search show them. */
export function usePlaces() {
  const { threads } = useThreads();
  const takes = useTakeValues();
  return useMemo(() => placesOf(threads, takes), [threads, takes]);
}
