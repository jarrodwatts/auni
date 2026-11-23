"use client";

import type { MessageId, ThreadId } from "@auni/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "sonner";

import { AutonomyPicker } from "@/components/app/autonomy-picker";
import { Composer, requestComposerFocus } from "@/components/app/composer";
import { COMPOSER_DOCK_CLASS_NAME } from "@/components/app/composer-shell";
import { useConversationLaunch } from "@/components/app/conversation-launch-context";
import { TRANSCRIPT_COLUMN_CLASS_NAME } from "@/components/app/conversation-history-preview";
import { ConversationMessage } from "@/components/app/conversation-message";
import { DayRule, dayLabel } from "@/components/app/day-rule";
import { EmptyThread } from "@/components/app/empty-thread";
import { EnvironmentPicker } from "@/components/app/environment-picker";
import { ModelPicker } from "@/components/app/model-picker";
import { useChangeThread, useThreads } from "@/components/app/use-threads";
import { ThreadFailureNotice } from "@/components/app/thread-failure-notice";
import { useThreadTranscript } from "@/components/app/use-thread-transcript";
import { useThreadState } from "@/components/portfolio/use-portfolio";
import { BrainNeeded, useNoBrainYet } from "@/components/first-run/brain-needed";
import { SpareKey } from "@/components/first-run/spare-key";
import { ArrivedForCard } from "@/components/cards/money/arrived-line";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationViewportFollow,
} from "@/components/ai-elements/conversation";
import { QuestionPicker } from "@/components/conversation/question-picker";
import { useTrailingTextFlow } from "@/components/conversation/use-text-flow";
import { moneyProgress } from "@/components/places/attention";
import {
  answerStartedAt,
  answeredQuestion,
  createOptimisticUserMessage,
  editableExchange,
  messageQuestion,
  pendingAnswer,
  turnKeys,
  visibleThreadMessages,
} from "@/lib/conversation";
import { useSustained } from "@/lib/use-sustained";
import type { StickToBottomContext } from "use-stick-to-bottom";

import { arrivalsForCards } from "@/lib/arrivals-for-cards";

/**
 * A place's one conversation, split by day: the transcript and the reply
 * box. The place around it draws the header and the money.
 */
export function ThreadPane({
  threadId,
  placeholder,
}: {
  readonly threadId: ThreadId;
  readonly placeholder: string;
}) {
  const { launch, settle: settleLaunch } = useConversationLaunch();
  const { readThread, refreshThreads, threads } = useThreads();
  const changeThread = useChangeThread();
  const thread = threads.find(({ id }) => id === threadId);
  const threadState = useThreadState(threadId);
  const money = moneyProgress(thread?.moving ?? null);
  const {
    failure,
    historyFailed,
    historyReady,
    messages,
    retry,
    returnedDraft,
    status,
    stop,
    submitMessage: sendTranscriptMessage,
    backgroundStarting,
  } = useThreadTranscript(threadId);
  // Read once the answer can be on screen; a history that fails to load leaves it unread.
  useReadWhileOpen(
    threadId,
    historyReady && !historyFailed && (thread?.unread ?? false),
    readThread,
  );
  const conversation = useRef<StickToBottomContext>(null);
  const [editing, setEditing] = useState<{
    readonly userMessageId: string;
    readonly text: string;
  } | null>(null);

  const initialLaunch = launch?.thread?.id === threadId ? launch : null;
  const persistedVisibleMessages = visibleThreadMessages(messages);
  const visibleMessages =
    persistedVisibleMessages.length > 0
      ? persistedVisibleMessages
      : initialLaunch
        ? [
            createOptimisticUserMessage(initialLaunch.messageId, initialLaunch.prompt, {
              sentAt: initialLaunch.startedAt,
            }),
          ]
        : [];

  const trailingMessage = visibleMessages.at(-1);
  const reveal = useTrailingTextFlow(trailingMessage, status === "streaming");
  const [sentMessageIds, setSentMessageIds] = useState<ReadonlySet<string>>(() => new Set());

  const submitMessage = useCallback(
    async (...args: Parameters<typeof sendTranscriptMessage>) => {
      reveal.flush();
      const [content, providedId, supersedesMessageId] = args;
      const messageId = providedId ?? crypto.randomUUID();
      setSentMessageIds((current) => {
        const next = new Set(current);
        next.add(messageId);
        return next;
      });
      // Sending takes the reader to the end, wherever they had scrolled.
      void conversation.current?.scrollToBottom("instant");
      await sendTranscriptMessage(content, messageId, supersedesMessageId);
    },
    [reveal, sendTranscriptMessage],
  );

  useEffect(() => {
    if (initialLaunch && messages.some(({ id }) => id === initialLaunch.messageId)) {
      settleLaunch(threadId);
    }
  }, [initialLaunch, messages, settleLaunch, threadId]);

  const busy = status === "submitted" || status === "streaming";
  // With no AI to think with, a message's answer can only ask for one: it's drawn so from the send.
  const brainless = useNoBrainYet();
  // The answer a running turn will give, drawn from the send so its first words land in
  // a place that already exists: a quiet thinking line, then any steps, then words.
  // A turn core started before this visit heard it: only the thread's row says so. Held
  // a moment first, since that row also trails behind a turn this visit just watched end.
  const joinedLate = useSustained(
    status === "ready" &&
      thread?.state === "running" &&
      trailingMessage?.role !== "user" &&
      !reveal.revealing &&
      !backgroundStarting,
    1_000,
  );
  const answerToCome =
    trailingMessage?.role === "user" && (busy || initialLaunch || thread?.state === "running")
      ? pendingAnswer(trailingMessage)
      : (status === "ready" && (backgroundStarting || joinedLate)) ||
          (busy && trailingMessage?.metadata?.posted)
        ? pendingAnswer(null)
        : null;
  const turns = answerToCome ? [...visibleMessages, answerToCome] : visibleMessages;
  // An answer and the stand-in drawn before it share a key, so the first words land in
  // the same component: its clock, folds and steps carry straight on.
  const keys = turnKeys(turns);
  // Money that came in for a card is told in that card, not again under it.
  const arrivals = arrivalsForCards(turns);
  // A turn Auni starts by itself (a move landed, a watch fired) is read from its start: the
  // follow stops at its beginning, with the end of what the owner was looking at still above
  // it, where following to the end would open a tall card on its last line. It holds until
  // the owner scrolls on or the next turn begins; the history as it loads is never held.
  const newest = keys.at(-1);
  const [newestSeen, setNewestSeen] = useState<string>();
  const [readFromStart, setReadFromStart] = useState<string>();
  if (historyReady && newest !== newestSeen) {
    const turn = turns.at(-1);
    const ownTurn = turn?.role === "assistant" && turn.metadata?.origin !== "human";
    setNewestSeen(newest);
    setReadFromStart(newestSeen !== undefined && ownTurn ? newest : undefined);
  }
  const readOn = useCallback(() => setReadFromStart(undefined), []);
  // A turn starting picks the end back up for a reader resting there; one who scrolled
  // away or opened something keeps their place.
  const turnLive = busy || Boolean(answerToCome);
  useEffect(() => {
    const view = conversation.current;
    if (turnLive && view?.isAtBottom) void view.scrollToBottom();
  }, [turnLive]);
  // A row whose live update was lost would keep saying "running" after the turn ended.
  useEffect(() => {
    if (!busy) return undefined;
    return () => void refreshThreads();
  }, [busy, refreshThreads]);
  const regenerable = busy || reveal.revealing ? null : editableExchange(visibleMessages);
  // Only a message still shown may be replaced; an edit left behind is dropped.
  const editingMessageId =
    editing && visibleMessages.some(({ id }) => id === editing.userMessageId)
      ? (editing.userMessageId as MessageId)
      : undefined;
  // Answered the moment anything follows it; an edit rewinds past it. Closed, it stays down
  // until the next question, and the words below still answer it.
  const [closedQuestionId, setClosedQuestionId] = useState<string | null>(null);
  // An answer saying no AI could think asks for one itself (BrainNeeded), not with a docked Try again.
  const question =
    busy || reveal.revealing || editingMessageId || trailingMessage?.metadata?.noBrain
      ? null
      : messageQuestion(trailingMessage);
  // Signed in, the message that found no AI goes again in its own place.
  const askAgainWithBrain = () => {
    if (regenerable)
      void submitMessage(
        regenerable.text,
        crypto.randomUUID(),
        regenerable.userMessageId as MessageId,
      );
  };
  const openQuestion = question?.id === closedQuestionId ? null : question;
  const askAgent = useCallback(
    async (prompt: string) => {
      if (busy) return false;
      await submitMessage(prompt);
      return true;
    },
    [busy, submitMessage],
  );

  // Keep resizing instant through the first history layout so opening an
  // uncached thread lands on its newest message instead of scrolling through older ones.
  const [smoothFollow, setSmoothFollow] = useState(historyReady);
  useEffect(() => {
    if (!historyReady || smoothFollow) return undefined;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSmoothFollow(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [historyReady, smoothFollow]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col px-0 sm:px-5 sm:pt-6 sm:pb-4 lg:px-8 lg:pb-5">
        <Conversation
          contextRef={conversation}
          // Opening a thread lands on its end at once; only a live answer glides.
          resize={smoothFollow ? "smooth" : "instant"}
        >
          <ConversationContent
            className={TRANSCRIPT_COLUMN_CLASS_NAME}
            data-timeline-loading={!historyReady || undefined}
            onReadOn={readOn}
          >
            {!historyReady ? (
              <span className="sr-only" role="status">
                Loading conversation history.
              </span>
            ) : null}
            {visibleMessages.length === 0 &&
            historyReady &&
            !busy &&
            !answerToCome &&
            thread?.state !== "running" ? (
              <EmptyThread />
            ) : null}

            {turns.map((message, index) => {
              if (arrivals.folded.has(index)) return null;
              const standIn = message === answerToCome;
              // Money arriving, say, is no answer: a turn starting meanwhile is told by its own.
              const live =
                standIn ||
                (busy && message.id === trailingMessage?.id && !message.metadata?.posted);
              return (
                <div
                  key={keys[index]}
                  className="min-w-0"
                  data-slot="conversation-turn"
                  data-owner-turn={message.role === "user" || undefined}
                  data-read-from-start={keys[index] === readFromStart || undefined}
                >
                  {/* A watch's answer opens on its own rule, which says the day. */}
                  <DayRule
                    label={message.metadata?.fires ? null : dayLabel(message, turns[index - 1])}
                  />
                  {message.metadata?.noBrain ||
                  (standIn && brainless && message.metadata?.origin === "human") ? (
                    <BrainNeeded
                      latest={!busy && message.id === trailingMessage?.id}
                      onReady={askAgainWithBrain}
                    />
                  ) : (
                    <ArrivedForCard value={arrivals.told.get(index) ?? NONE_ARRIVED}>
                      <ConversationMessage
                        animateEnter={message.role === "user" && sentMessageIds.has(message.id)}
                        answering={answeredQuestion(turns, index)}
                        threadId={threadId}
                        isStreaming={
                          status === "streaming" &&
                          message.role === "assistant" &&
                          index === visibleMessages.length - 1
                        }
                        message={message}
                        pending={live}
                        workStartedAt={
                          standIn || message.id === trailingMessage?.id
                            ? answerStartedAt(turns, index)
                            : undefined
                        }
                        onAskAgent={askAgent}
                        onEditMessage={
                          regenerable && !failure && message.id === regenerable.userMessageId
                            ? () => setEditing(regenerable)
                            : undefined
                        }
                        onRegenerate={
                          regenerable && !failure && index === visibleMessages.length - 1
                            ? () =>
                                void submitMessage(
                                  regenerable.text,
                                  crypto.randomUUID(),
                                  regenerable.userMessageId as MessageId,
                                )
                            : undefined
                        }
                        flow={reveal.flowFor(message.id)}
                      />
                    </ArrivedForCard>
                  )}
                </div>
              );
            })}
            {/* With no AI to think, the ask for one is the way on, not a Try again. */}
            {failure && !trailingMessage?.metadata?.noBrain ? (
              <ThreadFailureNotice failure={failure} onRetry={() => void retry()} />
            ) : null}
            {/* Money in, Auni offers the spare key here, wherever the owner is talking to it. */}
            {historyReady && !turnLive && !reveal.revealing ? <SpareKey /> : null}
          </ConversationContent>
          <ConversationViewportFollow />
          <ConversationScrollButton
            moving={money?.status === "now" ? money : null}
            onReadOn={readOn}
          />
        </Conversation>

        <div className={COMPOSER_DOCK_CLASS_NAME}>
          <Composer
            // Remounting with the returned or edited words puts them back under the cursor.
            key={editing?.userMessageId ?? returnedDraft?.key ?? threadId}
            // Wait for history before autofocusing so an arriving QuestionPicker keeps its number-key shortcuts.
            autoFocus={historyReady && !openQuestion}
            // With no AI to think with, a turn only asks for one: nothing is running to stop.
            busy={busy && !brainless}
            disabled={historyFailed}
            draftKey={threadId}
            initialMessage={editing?.text ?? returnedDraft?.text ?? ""}
            lead={
              openQuestion ? (
                <QuestionPicker
                  key={openQuestion.id}
                  question={openQuestion}
                  onClose={() => {
                    setClosedQuestionId(openQuestion.id);
                    requestComposerFocus(threadId);
                  }}
                />
              ) : undefined
            }
            inlineControl={
              <ModelPicker
                value={thread?.modelSelection}
                onChange={(modelSelection) =>
                  void changeThread(threadId, { modelSelection }).catch(() =>
                    toast.error("That model choice couldn't be saved. Try again."),
                  )
                }
                disabled={!historyReady || historyFailed}
              />
            }
            footerStrip={
              <>
                <EnvironmentPicker />
                <AutonomyPicker
                  actMode={thread?.actMode ?? "ask_first"}
                  budgetUsd={thread?.budgetUsd ?? "0"}
                  freeBudgetUsd={threadState.data?.freeBudgetUsd ?? null}
                  threadTitle={thread?.title}
                  onChange={(next) =>
                    void changeThread(threadId, next).catch(() =>
                      toast.error("That permission change couldn't be saved. Try again."),
                    )
                  }
                  disabled={!historyReady || historyFailed}
                />
              </>
            }
            onStop={() => void stop()}
            onSubmit={async (content) => {
              setEditing(null);
              await submitMessage(content, crypto.randomUUID(), editingMessageId);
            }}
            placeholder={openQuestion ? "Or say something else" : placeholder}
            sendDisabled={!historyReady}
          />
        </div>
      </div>
    </section>
  );
}

/** An answer shown in the open thread is read once the page is in front of the person. */
function useReadWhileOpen(
  threadId: ThreadId,
  unread: boolean,
  readThread: (threadId: ThreadId) => void,
): void {
  useEffect(() => {
    if (!unread) return undefined;
    const readIfShown = () => {
      if (document.visibilityState === "visible") readThread(threadId);
    };
    readIfShown();
    document.addEventListener("visibilitychange", readIfShown);
    return () => document.removeEventListener("visibilitychange", readIfShown);
  }, [readThread, threadId, unread]);
}

/** No money came in for a card. */
const NONE_ARRIVED = [] as const;
