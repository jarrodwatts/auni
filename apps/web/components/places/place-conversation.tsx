"use client";

import type { SpecialistId, ThreadId } from "@auni/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { COMPOSER_DOCK_CLASS_NAME, ComposerLoadingSurface } from "@/components/app/composer-shell";
import { ConversationHistoryPreview } from "@/components/app/conversation-history-preview";
import { ThreadHistoryLoading } from "@/components/app/thread-history-loading";
import { ThreadPane } from "@/components/app/thread-pane";
import { useThreads } from "@/components/app/use-threads";
import { getSpecialistThread } from "@/lib/data/places";

/**
 * A specialist's one thread. The sidebar's list already knows every one that
 * has said something; one that hasn't gets its thread made on first visit.
 */
export function useSpecialistThread(specialistId: SpecialistId): ThreadId | null {
  const { loading, rememberThread, threads } = useThreads();
  const listed = threads.find((thread) => thread.specialistId === specialistId);
  const made = useQuery({
    queryKey: ["specialist-thread", specialistId],
    queryFn: ({ signal }) => getSpecialistThread(specialistId, signal),
    enabled: !loading && !listed,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (made.data) rememberThread(made.data);
  }, [made.data, rememberThread]);
  return listed?.id ?? made.data?.id ?? null;
}

/** A place's conversation, or its quiet stand-in while its thread is found. */
export function PlaceConversation({
  threadId,
  placeholder,
}: {
  readonly threadId: ThreadId | null;
  readonly placeholder: string;
}) {
  if (threadId) return <ThreadPane key={threadId} threadId={threadId} placeholder={placeholder} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col px-0 sm:px-5 sm:pt-6 sm:pb-4 lg:px-8 lg:pb-5">
      <ConversationHistoryPreview>
        <ThreadHistoryLoading />
      </ConversationHistoryPreview>
      <div className={COMPOSER_DOCK_CLASS_NAME}>
        <ComposerLoadingSurface />
      </div>
    </div>
  );
}
