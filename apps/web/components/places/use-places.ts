"use client";

import { specialistIdSchema, threadIdSchema, type ThreadId } from "@auni/shared";
import { useParams, usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";

import { useThreads } from "@/components/app/use-threads";
import { useSpecialists } from "@/components/specialist/use-specialists";
import { APPS_HREF } from "@/lib/app-links";
import { threadPlace, type PlaceKey } from "@/lib/data/places";
import type { Specialist, Thread } from "@/lib/data/views";

import { attentionOf, chatStatus, type ChatStatus, type PlaceAttention } from "./attention";
import { listedSpecialists } from "./listed-specialists";
import { useSeenSpecialists } from "./stored-state";

/** Where the person is: Portfolio, Activity, Apps, a new chat, a specialist, or a chat. */
export type PlaceRoute =
  | { readonly kind: "portfolio" }
  | { readonly kind: "activity" }
  | { readonly kind: "apps" }
  | { readonly kind: "new" }
  | { readonly kind: "specialist"; readonly id: Specialist["id"] }
  | { readonly kind: "chat"; readonly id: ThreadId };

export function usePlaceRoute(): PlaceRoute {
  const pathname = usePathname();
  const params = useParams<{ specialist?: string; thread?: string }>();
  const specialist = specialistIdSchema.safeParse(params.specialist);
  if (specialist.success) return { kind: "specialist", id: specialist.data };
  const chat = threadIdSchema.safeParse(params.thread);
  if (chat.success) return { kind: "chat", id: chat.data };
  if (pathname === "/app/activity") return { kind: "activity" };
  if (pathname === APPS_HREF) return { kind: "apps" };
  return pathname === "/app/new" ? { kind: "new" } : { kind: "portfolio" };
}

export interface SpecialistPlace {
  readonly specialist: Specialist;
  /** Its conversation, once it has one in the list. */
  readonly thread: Thread | undefined;
  /** A card in its conversation waits on the person. */
  readonly waiting: boolean;
  readonly attention: PlaceAttention;
  /** The agent just made it and it hasn't been opened yet. */
  readonly fresh: boolean;
}

/** A conversation outside every specialist. */
export interface ChatPlace {
  readonly thread: Thread;
  /** A card in it waits on the person. */
  readonly waiting: boolean;
  readonly status: ChatStatus;
}

const FRESH_MS = 24 * 60 * 60 * 1_000;
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

/** The place on screen, by the key its thread is listed under. */
function placeOnScreen(route: PlaceRoute): PlaceKey | null {
  return route.kind === "chat" || route.kind === "specialist" ? route.id : null;
}

/**
 * Every place, as the sidebar, the rail and Portfolio show them: the specialists
 * (closed ones last, until archived), then the chats (archived ones leave), newest
 * first, with what waits on the person read from each one's thread. An archived
 * chat with a card waiting stays listed, so tidying never hides a card; the
 * archived chats are kept apart for search. The place on screen points at nothing:
 * what waits there, or came in there, is in front of the person already.
 */
export function usePlaces() {
  const specialists = useSpecialists();
  const { threads } = useThreads();
  const seen = useSeenSpecialists();
  const now = useMinute();
  const here = placeOnScreen(usePlaceRoute());

  return useMemo(() => {
    const waiting = new Map<PlaceKey, Thread>();
    const listed = threads.filter(({ archived, state }) => !archived || state === "needs_user");
    const byPlace = new Map(listed.map((thread) => [threadPlace(thread), thread]));
    for (const thread of listed)
      if (thread.state === "needs_user" && threadPlace(thread) !== here)
        waiting.set(threadPlace(thread), thread);

    const places: SpecialistPlace[] = listedSpecialists(specialists.data ?? [], byPlace).map(
      (specialist) => ({
        specialist,
        thread: byPlace.get(specialist.id),
        waiting: waiting.has(specialist.id),
        attention:
          specialist.id === here ? null : attentionOf(byPlace.get(specialist.id), specialist),
        fresh:
          specialist.status !== "retired" &&
          !seen.has(specialist.id) &&
          now - Date.parse(specialist.startedAt) < FRESH_MS,
      }),
    );

    const chatPlace = (thread: Thread): ChatPlace => ({
      thread,
      waiting: waiting.has(thread.id),
      status: chatStatus(thread),
    });
    const newestFirst = (a: Thread, b: Thread) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    const chats = listed
      .filter((thread) => !thread.specialistId)
      .toSorted(newestFirst)
      .map(chatPlace);
    const archived = threads
      .filter((thread) => !thread.specialistId && !listed.includes(thread))
      .toSorted(newestFirst)
      .map(chatPlace);

    return {
      specialists: places,
      chats,
      /** The chats archived out of History, newest first, which only search shows. */
      archived,
      /** Each place's thread that waits on the person, keyed by place. */
      waiting,
      /** How many listed places wait on the person. */
      waitingCount: [...places, ...chats].filter((place) => place.waiting).length,
    };
  }, [specialists.data, now, seen, threads, here]);
}
