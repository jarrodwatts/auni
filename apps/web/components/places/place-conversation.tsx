"use client";

import type { ThreadId } from "@auni/shared";

import { COMPOSER_DOCK_CLASS_NAME, ComposerStandin } from "@/components/app/composer-shell";
import { ThreadPane } from "@/components/app/thread-pane";

/** A thread's conversation, or a calm empty canvas while its thread resolves. */
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
      <div className="min-h-0 flex-1" data-timeline-loading="true">
        <span className="sr-only" role="status">
          Loading conversation history.
        </span>
      </div>
      <div className={COMPOSER_DOCK_CLASS_NAME}>
        <ComposerStandin placeholder={placeholder} />
      </div>
    </div>
  );
}
