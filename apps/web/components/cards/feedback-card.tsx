"use client";

import type { CardWire } from "@auni/shared";
import { Blocks, Bug, Lightbulb } from "lucide-react";
import { useState } from "react";

import { FeedbackBody } from "@/components/feedback/feedback-body";

import { CardFrame, CardHead } from "./card-parts";

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
    <CardFrame
      auni={opened ? { kind: "landed" } : { kind: "ready" }}
      label={feedback.heading}
      phase="open"
    >
      <CardHead
        mark={
          <span className="flex size-11 flex-none items-center justify-center rounded-full bg-glyph-plate text-glyph-ink">
            <Icon aria-hidden className="size-5" strokeWidth={2} />
          </span>
        }
        title={feedback.heading}
        line={feedback.why}
      />
      <div className="mt-5 border-t border-border pt-5">
        <FeedbackBody feedback={feedback} onOpened={() => setOpened(true)} />
      </div>
    </CardFrame>
  );
}
