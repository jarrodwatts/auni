"use client";

import type { CardWire } from "@auni/shared";
import { ChevronRight, RotateCw } from "lucide-react";
import { useId, useState } from "react";

import { ConversationCardBoundary } from "@/components/app/conversation-card-boundary";
import { AgentCard } from "@/components/cards/agent-card";
import type { AskAgentHandler } from "@/components/cards/ask-agent";
import { cn } from "@/lib/utils";

/** Each card renders inside its own error boundary, so one bad card never unmounts the thread. */
export function ConversationCards({
  cards,
  onAskAgent,
  retried,
}: {
  readonly cards: readonly CardWire[];
  /** Sends a follow-up the user chose from a card; absent where no composer exists. */
  readonly onAskAgent?: AskAgentHandler;
  /** Failed attempts a later try fixed: each folds to a line that opens to its card. */
  readonly retried?: ReadonlySet<string>;
}) {
  return cards.map((card) => (
    <ConversationCardBoundary card={card} key={card.id}>
      {retried?.has(card.id) ? (
        <RetriedAttempt card={card} />
      ) : (
        <AgentCard card={card} onAskAgent={onAskAgent} />
      )}
    </ConversationCardBoundary>
  ));
}

/** A first try that didn't go through, quiet because the retry below it did. */
function RetriedAttempt({ card }: { readonly card: CardWire }) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => setOpen(!open)}
        className="flex min-h-9 items-center gap-2 rounded-md text-[14px] text-muted-foreground transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <RotateCw aria-hidden className="size-3.5" strokeWidth={1.75} />
        First try didn&apos;t go through
        <ChevronRight
          aria-hidden
          strokeWidth={1.5}
          className={cn(
            "size-3.5 transition-transform duration-200 ease-settle motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div id={cardId} className="auni-stagger-in">
          <AgentCard card={card} />
        </div>
      ) : null}
    </div>
  );
}
