"use client";

import type { ThreadId } from "@auni/shared";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { useRefreshSpecialists } from "@/components/specialist/use-specialists";
import {
  deleteThread,
  listThreads,
  markThreadRead,
  updateThread,
  watchThreadRows,
} from "@/lib/data/threads";
import type { Thread } from "@/lib/data/views";

const THREADS_KEY = ["threads"] as const;
const NO_THREADS: readonly Thread[] = [];

type ThreadChange = Partial<Pick<Thread, "title" | "archived">>;

/**
 * Each specialist's one thread, and every chat. Read once, then kept current by the rows core
 * streams (useLiveThreadRows); a failed read tries again when the window regains focus.
 */
export function useThreads() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: THREADS_KEY,
    queryFn: async () => {
      const next = await listThreads();
      // A place's thread read on its own (still empty, so unlisted) stays known.
      const known = queryClient.getQueryData<readonly Thread[]>(THREADS_KEY) ?? [];
      return next.reduce(upsertThread, known.filter(isUnlisted(next)));
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: (query) => query.state.status === "error",
    refetchOnReconnect: (query) => query.state.status === "error",
  });

  /** Adds or refreshes a place's thread read outside the list (routing, a first visit). */
  const rememberThread = useCallback(
    (thread: Thread) => rememberRow(queryClient, thread),
    [queryClient],
  );
  const refreshThreads = useCallback(
    () => queryClient.invalidateQueries({ queryKey: THREADS_KEY }),
    [queryClient],
  );
  /** Clears a thread's unread answer at once; if core misses it, the next read of the list brings it back. */
  const readThread = useCallback(
    (threadId: ThreadId) => {
      patchThread(queryClient, threadId, { unread: false });
      void markThreadRead(threadId).catch(() => undefined);
    },
    [queryClient],
  );

  return {
    loading: list.isFetching,
    threads: list.data ?? NO_THREADS,
    rememberThread,
    refreshThreads,
    readThread,
  };
}

/**
 * Renames a chat, or archives it or brings it back, at once; if core refuses, the change is
 * undone and it rejects.
 * Changes go to core one at a time, so an undo never lands before what it undoes.
 */
export function useChangeThread(): (threadId: ThreadId, change: ThreadChange) => Promise<void> {
  const queryClient = useQueryClient();
  const { mutateAsync } = useMutation({
    scope: { id: "thread-change" },
    // Offline fails at once and rolls back, as with core down, rather than waiting to reconnect.
    networkMode: "always",
    mutationFn: ({ threadId, change }: { threadId: ThreadId; change: ThreadChange }) =>
      updateThread(threadId, change),
    onMutate: ({ threadId, change }) => {
      const before = queryClient
        .getQueryData<readonly Thread[]>(THREADS_KEY)
        ?.find(({ id }) => id === threadId);
      patchThread(queryClient, threadId, change);
      return before;
    },
    onError: (_error, { threadId, change }, before) => {
      if (!before) return;
      patchThread(queryClient, threadId, {
        ...(change.title === undefined ? {} : { title: before.title }),
        ...(change.archived === undefined ? {} : { archived: before.archived }),
      });
    },
  });
  return useCallback(
    async (threadId, change) => {
      const listed = queryClient.getQueryData<readonly Thread[]>(THREADS_KEY);
      if (listed?.some(({ id }) => id === threadId)) await mutateAsync({ threadId, change });
    },
    [mutateAsync, queryClient],
  );
}

/**
 * Keeps the list live, mounted once: core says when a turn begins or ends or an action waits on
 * the person. A turn can also create or change a specialist, so every row that stops working
 * re-reads the specialists too.
 */
export function useLiveThreadRows(): void {
  const queryClient = useQueryClient();
  const refreshSpecialists = useRefreshSpecialists();
  const refreshSpecialistsRef = useRef(refreshSpecialists);
  useEffect(() => {
    refreshSpecialistsRef.current = refreshSpecialists;
  });
  useEffect(
    () =>
      watchThreadRows(
        (thread) => {
          rememberRow(queryClient, thread);
          if (thread.state !== "running") refreshSpecialistsRef.current();
        },
        (threadId) => forgetRow(queryClient, threadId),
        // Whatever changed while the socket was down is read in whole.
        () => {
          refreshSpecialistsRef.current();
          void queryClient.invalidateQueries({ queryKey: THREADS_KEY });
        },
      ),
    [queryClient],
  );
}

/**
 * Deletes a chat for good once core agrees; core can refuse, saying why, and then nothing
 * changes here. Every tab drops the row as core says it is gone.
 */
export function useDeleteThread(): (threadId: ThreadId) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (threadId) => {
      await deleteThread(threadId);
      forgetRow(queryClient, threadId);
    },
    [queryClient],
  );
}

function forgetRow(queryClient: QueryClient, threadId: ThreadId): void {
  queryClient.setQueryData<readonly Thread[]>(THREADS_KEY, (threads) =>
    threads?.filter(({ id }) => id !== threadId),
  );
}

function rememberRow(queryClient: QueryClient, row: Thread): void {
  if (queryClient.getQueryData(THREADS_KEY))
    queryClient.setQueryData<readonly Thread[]>(THREADS_KEY, (threads) =>
      threads ? upsertThread(threads, row) : threads,
    );
  // Not read yet, or the read failed: a read now has this row and everything before it.
  else void queryClient.invalidateQueries({ queryKey: THREADS_KEY });
}

function patchThread(queryClient: QueryClient, threadId: ThreadId, fields: Partial<Thread>): void {
  queryClient.setQueryData<readonly Thread[]>(THREADS_KEY, (threads) =>
    threads?.map((thread) => (thread.id === threadId ? { ...thread, ...fields } : thread)),
  );
}

function isUnlisted(listed: readonly Thread[]) {
  const ids = new Set(listed.map(({ id }) => id));
  return (thread: Thread) => !ids.has(thread.id);
}

function upsertThread(threads: readonly Thread[], row: Thread): readonly Thread[] {
  return [row, ...threads.filter(({ id }) => id !== row.id)].toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}
