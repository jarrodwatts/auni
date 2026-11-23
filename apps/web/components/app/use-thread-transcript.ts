"use client";

import type { MessageId, ThreadId } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  HISTORY_FAILURE,
  SEND_FAILURES,
  type ThreadFailure,
} from "@/components/app/thread-failure";
import { threadSession } from "@/lib/data/thread-session";

/** A thread's conversation as its pane draws it, from the tab's session for it. */
export function useThreadTranscript(threadId: ThreadId) {
  const session = useMemo(() => threadSession(threadId), [threadId]);
  const {
    history,
    messages,
    send: sent,
    turn,
  } = useSyncExternalStore(session.subscribe, session.read, session.read);

  // A turn core started on its own (an action settled, a deposit landed, a watch fired),
  // still before its first words.
  const backgroundStarting = turn?.stage === "submitted" && !turn.sent ? turn.id : null;
  const queryClient = useQueryClient();
  useEffect(() => {
    // Such a turn is usually a run that just finished: the cards in the thread read it now,
    // so they settle before Auni starts talking about it.
    if (backgroundStarting) void queryClient.invalidateQueries({ queryKey: ["proposal"] });
  }, [backgroundStarting, queryClient]);

  const failure: ThreadFailure | null =
    history === "failed" ? HISTORY_FAILURE : sent?.failure ? SEND_FAILURES[sent.failure] : null;

  // Sent mid-turn, it is answered once that turn ends, as from any app; an edit stops the turn
  // answering the words it replaces, in core (conversation/send.ts).
  const submitMessage = useCallback(
    async (content: string, messageId?: string, supersedesMessageId?: MessageId) => {
      await session.send(content, { id: messageId, supersedesId: supersedesMessageId });
    },
    [session],
  );

  // Unconfirmed: the same message again, which core stores once. A failed turn
  // is asked again in place of it, and only when the person taps Try again.
  const resend = useCallback(async () => {
    if (!sent) return;
    if (failure?.action === "resend") await submitMessage(sent.text, sent.messageId);
    else await submitMessage(sent.text, undefined, sent.messageId as MessageId);
  }, [failure?.action, sent, submitMessage]);

  return {
    failure,
    historyFailed: history === "failed",
    historyReady: history !== "loading",
    messages,
    retry: failure?.action === "reload" ? session.resync : resend,
    /** Words that never became a turn, handed back so the person still has them. */
    returnedDraft: sent?.failure === "unsent" ? { key: sent.messageId, text: sent.text } : null,
    status: turn?.stage ?? ("ready" as const),
    backgroundStarting,
    stop: session.stop,
    submitMessage,
  };
}
