"use client";

import { useLayoutEffect, useRef } from "react";

import { Composer } from "@/components/app/composer";
import { COMPOSER_DOCK_CLASS_NAME } from "@/components/app/composer-shell";
import { ConversationHistoryPreview } from "@/components/app/conversation-history-preview";
import { ConversationMessage } from "@/components/app/conversation-message";
import { useConversationLaunch } from "@/components/app/conversation-launch-context";
import { Mascot } from "@/components/brand/mascot";
import { BrainNeeded, useNoBrainYet } from "@/components/first-run/brain-needed";
import { CHAT_PLACEHOLDER } from "@/components/places/chat-place";
import { PlaceHeader } from "@/components/places/place-header";
import { createOptimisticUserMessage, pendingAnswer } from "@/lib/conversation";

/**
 * The first moment of a new chat, held over the place while it starts: the question sent, Auni
 * on it, the reply box below. Drawn exactly as the thread will draw it, so the handover
 * underneath changes nothing. The owner's first take is carried in by the landing's dive, which
 * flies its words, its box and Auni into this frame: it draws no entrance of its own then.
 */
export function ConversationLaunchStage() {
  const { launch } = useConversationLaunch();
  const brainless = useNoBrainYet();
  const stage = useRef<HTMLElement>(null);
  const carried = launch?.carried ?? null;
  useLayoutEffect(() => {
    if (carried && stage.current) carried.arrive(stage.current);
  }, [carried]);

  if (!launch) return null;
  const message = createOptimisticUserMessage(launch.messageId, launch.prompt, {
    sentAt: launch.startedAt,
  });
  const placed = launch.thread;
  // The box invites what the chat it opens into will, once that chat is known.
  const placeholder = placed ? CHAT_PLACEHOLDER : "";

  return (
    <section
      ref={stage}
      aria-label="Starting conversation"
      // The landing has already said the chat is starting.
      aria-live={carried ? undefined : "polite"}
      data-carried={carried ? "" : undefined}
      data-phase={launch.phase}
      className="auni-conversation-launch absolute inset-0 z-30 flex h-full min-w-0 flex-col overflow-hidden bg-background"
      role={carried ? undefined : "status"}
    >
      {/* Once started, it wears the header of the chat it opens into, arriving softly. */}
      <PlaceHeader
        className="auni-conversation-launch-header"
        icon={placed ? null : <Mascot alt="" size={22} state="thinking" />}
        preview
        title={
          placed ? (
            <span key={placed.id} className="auni-segment-reveal">
              {placed.title}
            </span>
          ) : (
            ""
          )
        }
      />

      <div className="flex min-h-0 flex-1 flex-col px-0 sm:px-5 sm:pt-6 sm:pb-4 lg:px-8 lg:pb-5">
        <ConversationHistoryPreview>
          <div className="auni-conversation-launch-message min-w-0" data-slot="conversation-turn">
            <ConversationMessage isStreaming={false} message={message} />
          </div>
          {/* The answer to come, exactly as the thread will draw it before it hears a step. */}
          <div className="auni-conversation-launch-thinking min-w-0" data-slot="conversation-turn">
            {brainless ? (
              <BrainNeeded latest={false} onReady={() => undefined} />
            ) : (
              <ConversationMessage
                isStreaming={false}
                message={pendingAnswer(message)}
                pending
                firstAnswer
                workStartedAt={message.metadata?.createdAt}
              />
            )}
          </div>
        </ConversationHistoryPreview>

        <div
          aria-hidden
          inert
          className={`auni-conversation-launch-composer ${COMPOSER_DOCK_CLASS_NAME}`}
        >
          <Composer
            busy={!brainless}
            draftKey="launch"
            onStop={() => undefined}
            onSubmit={() => undefined}
            placeholder={placeholder}
          />
        </div>
      </div>
    </section>
  );
}
