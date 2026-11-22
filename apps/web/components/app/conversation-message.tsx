"use client";

import type { ThreadId } from "@auni/shared";
import { getToolName } from "ai";
import { Brain, OctagonPause, Pencil, RefreshCw } from "lucide-react";

import { AssistantMessageAvatar } from "@/components/app/assistant-message-avatar";
import { ConversationCards } from "@/components/app/conversation-cards";
import {
  CopyMessageAction,
  MessageActionsRow,
  MessageRowAction,
  MessageTimestamp,
  useLongPressReveal,
} from "@/components/app/message-action-row";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { ActivityRow } from "@/components/conversation/activity-row";
import { CardTakingShape } from "@/components/conversation/card-taking-shape";
import { GenericActivityTool } from "@/components/conversation/generic-activity-tool";
import { ReadingAuni } from "@/components/conversation/reading-auni";
import { SegmentedBubbles } from "@/components/conversation/segmented-bubbles";
import {
  answerWorkingLabel,
  currentThought,
  firstSentence,
  stepUnderWay,
} from "@/components/conversation/tool-working-status";
import type { TextFlowView } from "@/components/conversation/use-text-flow";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { auniActivityMood } from "@/lib/auni-activity";
import {
  messageCards,
  messageText,
  messageToolParts,
  type AuniQuestion,
  type AuniUiMessage,
} from "@/lib/conversation";
import { useShowThinking } from "@/components/places/stored-state";
import { FiredRule } from "@/components/watching/fired-rule";
import { WatchingLine } from "@/components/watching/watching-line";
import { messageTranscript } from "@/lib/message-transcript";
import { pagesRead, picksChosen, readingTheWeb, towardsACard } from "@/lib/pages-read";
import { cn } from "@/lib/utils";

interface ConversationMessageProps {
  /** On a user message: the question Auni asked just before it, which it answers. */
  readonly answering?: AuniQuestion | null;
  /** The thread it's in, so the watches the agent set up open their sheet. */
  readonly threadId?: ThreadId;
  readonly message: AuniUiMessage;
  readonly isStreaming: boolean;
  /** The turn behind this answer is still running; live work stays open until it ends. */
  readonly pending?: boolean;
  /** A chat's first answer, the longest wait: Auni reads beside the pages it opens until its words. */
  readonly firstAnswer?: boolean;
  /** When the request was sent; the live work clock counts up from it. */
  readonly workStartedAt?: string | undefined;
  /** Present only on the user message whose exchange may still be edited. */
  readonly onEditMessage?: () => void;
  /** Present only on the answer that may still be regenerated. */
  readonly onRegenerate?: () => void;
  /** Sends a follow-up the user chose from a card straight into the thread. */
  readonly onAskAgent?: AskAgentHandler;
  /** Single-cursor flow view for the live-streamed trailing message. */
  readonly flow?: TextFlowView;
}

/** Cards that move money, whose words stay beside them rather than fold into the work. */
const MONEY_CARDS = new Set<string>(["action", "action_plan", "specialist_proposal"]);

export function ConversationMessage({
  answering,
  flow,
  isStreaming,
  message,
  onAskAgent,
  onEditMessage,
  onRegenerate,
  firstAnswer = false,
  pending = false,
  threadId,
  workStartedAt,
}: ConversationMessageProps) {
  const text = messageText(message);
  const reveal = useLongPressReveal();
  const [showThinking] = useShowThinking();

  if (message.role !== "assistant") {
    return (
      // The owner's words and the answer under them read as one exchange: their actions show on
      // hover in the space under the bubble rather than holding a row of their own open.
      <Message align="end" className="pb-4" {...reveal}>
        <MessageContent>
          {answering?.question ? (
            // What the words answer, quiet over them; picked or typed, an answer is a message.
            <p
              className="-mb-1 line-clamp-2 max-w-[80%] self-end px-1 text-right text-[12.5px] leading-[17px] text-muted-foreground"
              dir="auto"
            >
              {answering.question}
            </p>
          ) : null}
          <Bubble align="end" variant="muted">
            {text.length > 0 && (
              <BubbleContent className="rounded-[20px_20px_6px_20px] px-[18px] py-3 text-[15px] leading-normal">
                <p className="whitespace-pre-wrap" dir="auto">
                  {text}
                </p>
              </BubbleContent>
            )}
            <ConversationCards cards={messageCards(message)} onAskAgent={onAskAgent} />
          </Bubble>
          <div className="absolute end-0 top-[calc(100%-12px)]">
            <MessageActionsRow align="end">
              {message.metadata?.createdAt ? (
                <MessageTimestamp className="mr-1.5" createdAt={message.metadata.createdAt} />
              ) : null}
              {text.length > 0 ? <CopyMessageAction text={text} /> : null}
              {onEditMessage ? (
                <MessageRowAction label="Edit message" onClick={onEditMessage}>
                  <Pencil aria-hidden />
                </MessageRowAction>
              ) : null}
            </MessageActionsRow>
          </div>
        </MessageContent>
      </Message>
    );
  }

  const transcript = messageTranscript(message);
  // A thought joins the steps as it's had, read whole on its own row while they're open, and the
  // line over them says only that the turn is working; folded away, the line says the thought.
  // With thinking hidden, no thought shows.
  const thinking = isStreaming && showThinking ? currentThought(message) : undefined;
  const timeline = transcript.activities.filter(({ part }) =>
    part.type === "data-reasoning" ? showThinking : true,
  );
  const placedCards = [
    ...transcript.activities.flatMap(({ cards }) => cards),
    ...transcript.trailingCards,
  ];
  const lastCardId = placedCards.at(-1)?.id;
  const working = isStreaming || pending;
  // Until its first step, a turn is thinking; after, the line says what it is doing.
  const liveLabel = working
    ? message.parts.length === 0
      ? "Thinking…"
      : (answerWorkingLabel(message, { showThinking }) ?? "Working…")
    : null;
  // The ask under an answer lands once its words have, so nothing below them ever moves.
  const settled =
    !working && (flow === undefined || (flow.visibleLength >= text.length && !flow.animating));
  const activityMood = auniActivityMood({
    activities: messageToolParts(message),
    streaming: isStreaming,
    text,
  });

  const { fires } = message.metadata ?? {};
  // A chat's first answer, the longest wait: what Auni reads, and the card it is building.
  const pages = firstAnswer ? pagesRead(message) : [];
  const shaping = firstAnswer && !settled ? towardsACard(message) : null;

  return (
    <>
      {fires ? <FiredRule fires={fires} createdAt={message.metadata?.createdAt} /> : null}
      {/* Its actions show on hover in the space under the answer, as the owner's do under their
          words, rather than holding a row of their own open between one answer and the next. */}
      <Message align="start" className="pb-4" {...reveal}>
        <AssistantMessageAvatar state={activityMood} />
        <MessageContent className="relative">
          <SegmentedBubbles
            workDurationMs={message.metadata?.workDurationMs}
            workStartedAt={workStartedAt}
            liveLabel={liveLabel}
            liveLabelIsStep={
              working && (stepUnderWay(message) !== undefined || thinking !== undefined)
            }
            activities={timeline.map(({ cards, key, offset, part }) => ({
              key,
              offset,
              // A thought alone leaves the words around it read.
              foldsText: part.type !== "data-reasoning",
              node:
                part.type === "data-reasoning" ? (
                  <ActivityRow
                    icon={<Brain className="size-3.5" aria-hidden />}
                    text={firstSentence(part.data.text)}
                    whole={part.data.text}
                  />
                ) : (
                  <GenericActivityTool
                    input={part.input}
                    live={working}
                    output={part.state === "output-available" ? part.output : undefined}
                    state={part.state}
                    toolName={getToolName(part)}
                  />
                ),
              cards:
                cards.length > 0 ? (
                  <ConversationCards
                    cards={cards}
                    retried={transcript.retried}
                    // A card something later followed up on offers no follow-up of its own.
                    onAskAgent={cards.some(({ id }) => id === lastCardId) ? onAskAgent : undefined}
                  />
                ) : undefined,
            }))}
            preserveText={
              transcript.watches.length > 0 || placedCards.some(({ kind }) => MONEY_CARDS.has(kind))
            }
            finalized={!working}
            flow={flow}
            text={text}
            trailing={
              <>
                {settled ? (
                  <ConversationCards
                    cards={transcript.trailingCards}
                    onAskAgent={onAskAgent}
                    retried={transcript.retried}
                  />
                ) : null}
                {settled && threadId && transcript.watches.length > 0 ? (
                  <WatchingLine threadId={threadId} automationIds={transcript.watches} />
                ) : null}
                {message.metadata?.stopped ? <StoppedAnswerNotice /> : null}
              </>
            }
          />
          {/* A chat's first answer, the longest wait, has Auni in it until its words: under the
              work, outside it, so it stays put as each step joins the work above it. */}
          {working && firstAnswer && text.length === 0 ? (
            <ReadingAuni pages={pages} searching={readingTheWeb(message)} />
          ) : null}
          {/* Under the work, then under the words, until the card itself lands in its place. */}
          {shaping && transcript.activities.every(({ cards }) => cards.length === 0) ? (
            <CardTakingShape
              making={shaping === "making"}
              chosen={picksChosen(message)}
            />
          ) : null}
          {text.length > 0 ? (
            // Hidden rather than unmounted while streaming, so the finish reveals
            // the actions instead of growing the answer under the reader.
            <div
              aria-hidden={isStreaming || undefined}
              className={cn("absolute start-0 top-[calc(100%+4px)]", isStreaming && "invisible")}
            >
              <MessageActionsRow align="start">
                <CopyMessageAction text={text} />
                {onRegenerate ? (
                  <MessageRowAction label="Regenerate answer" onClick={onRegenerate}>
                    <RefreshCw aria-hidden />
                  </MessageRowAction>
                ) : null}
                {message.metadata?.createdAt ? (
                  <MessageTimestamp className="ml-1.5" createdAt={message.metadata.createdAt} />
                ) : null}
              </MessageActionsRow>
            </div>
          ) : null}
        </MessageContent>
      </Message>
    </>
  );
}

/** Says this answer is short because the person stopped it. */
function StoppedAnswerNotice() {
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted-foreground/80">
      <OctagonPause className="size-3.5" aria-hidden />
      You stopped this answer.
    </p>
  );
}
