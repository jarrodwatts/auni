"use client";

import type { CardWire } from "@auni/shared";
import { Blocks, Bug, Lightbulb } from "lucide-react";
import { useState } from "react";

import { FeedbackBody } from "@/components/feedback/feedback-body";

import { MoneyCardFrame } from "./money/money-card-parts";

const ICON = { app: Blocks, bug: Bug, idea: Lightbulb } as const;

/**
 * Auni offering to pass something on to its maintainers: an app the owner wished for, a bug, an
 * idea. Rare, so it gets Auni over its edge, which sits up pleased once the form is open. The
 * card posts nothing itself (see FeedbackBody).
 */
export function FeedbackCard({
  card,
}: {
  readonly card: Extract<CardWire, { readonly kind: "feedback" }>;
}) {
  const { feedback } = card;
  const [opened, setOpened] = useState(false);
  const Icon = ICON[feedback.kind];
  return (
    <MoneyCardFrame
      auni={opened ? { kind: "landed" } : { kind: "ready" }}
      label={feedback.heading}
      phase="open"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-11 flex-none items-center justify-center rounded-full bg-glyph-plate text-glyph-ink">
          <Icon aria-hidden className="size-5" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-reading leading-[1.3] font-semibold tracking-[-0.015em] text-ink">
            {feedback.heading}
          </p>
          <p className="mt-0.5 text-meta leading-[18px] text-pretty text-muted-foreground">
            {feedback.why}
          </p>
        </div>
      </div>
      <div className="mt-5 border-t border-foreground/[0.06] pt-5">
        <FeedbackBody feedback={feedback} onOpened={() => setOpened(true)} />
      </div>
    </MoneyCardFrame>
  );
}
