"use client";

import type { ThreadId } from "@auni/shared";

import { COMPOSER_DOCK_CLASS_NAME, ComposerLoadingSurface } from "@/components/app/composer-shell";
import { ConversationHistoryPreview } from "@/components/app/conversation-history-preview";
import { ThreadHistoryLoading } from "@/components/app/thread-history-loading";
import { ThreadPane } from "@/components/app/thread-pane";

/** A thread's conversation, or its quiet stand-in while its thread is found. */
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
