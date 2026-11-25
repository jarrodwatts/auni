"use client";

import type { CardWire } from "@auni/shared";
import { ChevronRight, RotateCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

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
  const search = useSearchParams();
  const status = search.get("status");
  const target = status ?? search.get("card");
  return cards.map((card) => {
    const id =
      card.kind === "action_plan"
        ? card.proposalId
        : "actionReference" in card
          ? card.actionReference
          : card.id;
    const linked = target === id || target === card.id;
    const contents =
      retried?.has(card.id) && !linked ? (
        <RetriedAttempt card={card} />
      ) : (
        <AgentCard card={card} onAskAgent={onAskAgent} />
      );
    return (
      <ConversationCardBoundary card={card} key={card.id}>
        {linked ? (
          <LinkedCard
            checkStatus={status !== null}
            privateField={card.kind === "ask" && !!card.field}
          >
            {contents}
          </LinkedCard>
        ) : (
          contents
        )}
      </ConversationCardBoundary>
    );
  });
}

function LinkedCard({
  children,
  checkStatus,
  privateField,
}: {
  readonly children: ReactNode;
  readonly checkStatus: boolean;
  readonly privateField: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const { stopScroll } = useStickToBottomContext();
  useEffect(() => {
    // The transcript normally follows the newest message as history and live cards load.
    stopScroll();
    const animation = requestAnimationFrame(() => {
      const card = frame.current;
      if (!card) return;
      const check = checkStatus
        ? card.querySelector<HTMLButtonElement>("[data-check-status]")
        : null;
      const target = check ?? card;
      target.scrollIntoView({ block: "center" });
      // The private field focuses itself once it has loaded.
      if (!privateField) target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(animation);
  }, [checkStatus, privateField, stopScroll]);
  return (
    <div ref={frame} tabIndex={-1}>
      {children}
    </div>
  );
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
        className="flex min-h-9 items-center gap-2 rounded-control text-ui text-muted-foreground transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
