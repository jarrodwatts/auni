"use client";

import "./conversation-message.css";

import type { ThreadId } from "@auni/shared";
import { getToolName } from "ai";
import { OctagonPause, Pencil, RefreshCw } from "lucide-react";

import { ConversationCards } from "@/components/app/conversation-cards";
import {
  CopyMessageAction,
  MessageActionsRow,
  MessageRowAction,
  MessageTimestamp,
  useLongPressReveal,
} from "@/components/app/message-action-row";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { toolAppId, toolStepStatus } from "@/components/conversation/generic-activity-copy";
import { GenericActivityTool, ToolStepIcon } from "@/components/conversation/generic-activity-tool";
import { answerWorkingLabel } from "@/components/conversation/tool-working-status";
import { TurnBody } from "@/components/conversation/turn-body";
import type { TextFlowView } from "@/components/conversation/use-text-flow";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import {
  messageCards,
  messageText,
  type AuniQuestion,
  type AuniUiMessage,
} from "@/lib/conversation";
import { useShowThinking } from "@/components/places/stored-state";
import { FiredRule } from "@/components/watching/fired-rule";
import { WatchingLine } from "@/components/watching/watching-line";
import { messageTranscript } from "@/lib/message-transcript";
import { toolActivityTitle } from "@/lib/tool-copy";
import { cn } from "@/lib/utils";

interface ConversationMessageProps {
  /** Animate a newly sent user bubble gliding in; history messages mount statically. */
  readonly animateEnter?: boolean;
  /** On a user message: the question Auni asked just before it, which it answers. */
  readonly answering?: AuniQuestion | null;
  /** The thread it's in, so the watches the agent set up open their sheet. */
  readonly threadId?: ThreadId;
  readonly message: AuniUiMessage;
  readonly isStreaming: boolean;
  /** The turn behind this answer is still running; live work stays open until it ends. */
  readonly pending?: boolean;
  /** Present only on the user message whose exchange may still be edited. */
  readonly onEditMessage?: () => void;
  /** Present only on the answer that may still be regenerated. */
  readonly onRegenerate?: () => void;
  /** Sends a follow-up the user chose from a card straight into the thread. */
  readonly onAskAgent?: AskAgentHandler;
  /** Single-cursor flow view for the live-streamed trailing message. */
  readonly flow?: TextFlowView;
}

export function ConversationMessage({
  animateEnter = false,
  answering,
  flow,
  isStreaming,
  message,
  onAskAgent,
  onEditMessage,
  onRegenerate,
  pending = false,
  threadId,
}: ConversationMessageProps) {
  const text = messageText(message);
  const reveal = useLongPressReveal();
  const [showThinking] = useShowThinking();

  if (message.role !== "assistant") {
    return (
      // The owner's words and the answer under them read as one exchange: their actions show on
      // hover in the space under the bubble rather than holding a row of their own open.
      <Message align="end" className={cn("pb-4", animateEnter && "auni-message-enter")} {...reveal}>
        <MessageContent>
          {answering?.question ? (
            // What the words answer, quiet over them; picked or typed, an answer is a message.
            <p
              className="-mb-1 line-clamp-2 max-w-[80%] self-end px-1 text-right text-meta leading-[17px] text-muted-foreground"
              dir="auto"
            >
              {answering.question}
            </p>
          ) : null}
          <Bubble align="end" variant="muted">
            {text.length > 0 && (
              <BubbleContent className="rounded-sheet rounded-br-control px-4 py-2.5 text-reading">
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
  const timeline = transcript.activities.filter(({ part }) =>
    part.type === "data-reasoning" ? showThinking : true,
  );
  const placedCards = [
    ...transcript.activities.flatMap(({ cards }) => cards),
    ...transcript.trailingCards,
  ];
  const lastCardId = placedCards.at(-1)?.id;
  const working = isStreaming || pending;
  // Until its first step, a turn is thinking; after, the status reflects what it is doing.
  const liveLabel = working
    ? message.parts.length === 0
      ? "Thinking"
      : (answerWorkingLabel(message, { showThinking }) ?? "Thinking")
    : null;
  // The ask under an answer lands once its words have, so nothing below them ever moves.
  const settled =
    !working && (flow === undefined || (flow.visibleLength >= text.length && !flow.animating));

  const { fires } = message.metadata ?? {};

  return (
    <>
      {fires ? <FiredRule fires={fires} createdAt={message.metadata?.createdAt} /> : null}
      {/* Its actions show on hover in the space under the answer, as the owner's do under their
          words, rather than holding a row of their own open between one answer and the next. */}
      <Message align="start" className="pb-4" {...reveal}>
        <MessageContent className="relative">
          <TurnBody
            liveLabel={liveLabel}
            activities={timeline.map(({ cards, key, madeCards, offset, part }) => {
              const placed =
                cards.length > 0 ? (
                  <ConversationCards
                    cards={cards}
                    retried={transcript.retried}
                    // A card something later followed up on offers no follow-up of its own.
                    onAskAgent={cards.some(({ id }) => id === lastCardId) ? onAskAgent : undefined}
                  />
                ) : undefined;
              if (part.type === "data-reasoning")
                return { key, offset, thought: part.data.text, cards: placed };
              // A step that put up a card says nothing once done: the card is what it did.
              if (madeCards && part.state === "output-available")
                return { key, offset, cards: placed };
              const toolName = getToolName(part);
              const appId = toolAppId(toolName);
              return {
                key,
                offset,
                cards: placed,
                step: {
                  key,
                  iconKey: appId ? `app:${appId}` : `tool:${toolName}`,
                  icon: <ToolStepIcon size={20} toolName={toolName} />,
                  status: toolStepStatus(part.state, working),
                  title: toolActivityTitle(toolName, part.state),
                  node: (
                    <GenericActivityTool
                      input={part.input}
                      live={working}
                      output={part.state === "output-available" ? part.output : undefined}
                      state={part.state}
                      toolName={toolName}
                    />
                  ),
                },
              };
            })}
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
          {text.length > 0 ? (
            // Kept mounted while streaming so finishing reveals actions smoothly without shifting layout.
            <div
              aria-hidden={!settled || undefined}
              className={cn(
                "absolute start-0 top-[calc(100%+4px)] transition-opacity duration-240 ease-settle motion-reduce:transition-none",
                !settled && "pointer-events-none opacity-0",
              )}
              inert={!settled}
            >
              <MessageActionsRow align="start">
                <CopyMessageAction text={text} />
                {onRegenerate ? (
                  <MessageRowAction label="Ask again" onClick={onRegenerate}>
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
    <p className="mt-2 flex items-center gap-1.5 text-meta text-muted-foreground/80">
      <OctagonPause className="size-3.5" aria-hidden />
      You stopped this answer.
    </p>
  );
}
