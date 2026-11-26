"use client";

import "./segmented-bubbles.css";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { ThinkingIndicator } from "@/components/conversation/thinking-indicator";
import type { TextFlowView } from "@/components/conversation/use-text-flow";
import { formatSettledDuration, parseStartMs } from "@/components/conversation/work-clock";
import { WorkPanel, type WorkPanelStep } from "@/components/conversation/work-panel";
import type { Status } from "@/components/motion/status-mark";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { useSustained } from "@/lib/use-sustained";
import { cn } from "@/lib/utils";

/** Mid-turn silence after prose before showing a quiet trailing thinking line. */
const MID_TURN_PAUSE_MS = 700;

/** Tool or skill activity rendered in its place: after `offset` characters of the text. */
interface SegmentedBubbleActivity {
  readonly key: string;
  readonly offset: number;
  readonly iconKey: string;
  readonly icon: ReactNode;
  readonly isTool: boolean;
  readonly status: Status | null;
  readonly node: ReactNode;
  /** Cards stay mounted and visible at their originating activity. */
  readonly cards?: ReactNode;
}

interface SegmentedBubblesProps {
  readonly text: string;
  /** Core's measurement of the finished turn; the settled header reports it. */
  readonly workDurationMs?: number | undefined;
  /** When the request was sent; the live clock counts up from it. */
  readonly workStartedAt?: string | undefined;
  /** What the live turn is doing, shown while thinking or when a live panel is collapsed. */
  readonly liveLabel?: string | null;
  /** True once the assistant turn is complete; bubbles then render statically. */
  readonly finalized: boolean;
  readonly flow?: TextFlowView;
  /** Activity in the order it happened, each placed by the text before it. */
  readonly activities?: readonly SegmentedBubbleActivity[];
  /** Rendered after the last bubble: the answer's closing cards and notices. */
  readonly trailing?: ReactNode;
}

interface BubbleModel {
  readonly leading: readonly SegmentedBubbleActivity[];
  readonly segment?: string;
  /** Offset into the message text where this bubble's run begins. */
  readonly runStart: number;
}

export function SegmentedBubbles({
  activities = [],
  finalized,
  flow,
  liveLabel,
  text,
  trailing,
  workDurationMs,
  workStartedAt,
}: SegmentedBubblesProps) {
  const settled =
    finalized && (flow === undefined || (flow.visibleLength >= text.length && !flow.animating));
  // Remember if this answer was observed live so its initial Thinking line folds
  // smoothly away when text starts first instead of disappearing in one frame.
  const [drewLive, setDrewLive] = useState(!settled);
  if (!settled && !drewLive) setDrewLive(true);

  // Measure live turn duration once on settle (zero per-second React re-renders).
  const liveStartRef = useRef<number | null>(null);
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  useEffect(() => {
    if (!settled) {
      if (liveStartRef.current === null) {
        liveStartRef.current = parseStartMs(workStartedAt, Date.now());
      }
      return undefined;
    }
    if (liveStartRef.current === null) return undefined;
    const elapsed = Math.max(0, Date.now() - liveStartRef.current);
    liveStartRef.current = null;
    const frame = window.requestAnimationFrame(() => setMeasuredMs(elapsed));
    return () => window.cancelAnimationFrame(frame);
  }, [settled, workStartedAt]);

  const shownText = flow === undefined ? text : text.slice(0, flow.visibleLength);
  const bubbles = layOutBubbles({
    activities:
      flow === undefined
        ? activities
        : activities.filter((activity) => activity.offset <= shownText.length),
    text: shownText,
  });

  const displayBubbles: readonly BubbleModel[] =
    bubbles.length > 0 ? bubbles : [{ leading: [], runStart: 0 }];
  const lastIndex = displayBubbles.length - 1;
  const lastSegmentIndex = displayBubbles.findLastIndex((bubble) => bubble.segment !== undefined);
  const workPanelIndices = displayBubbles.flatMap((bubble, index) =>
    bubble.leading.length > 0 ? [index] : [],
  );
  const lastWorkIndex = workPanelIndices.at(-1) ?? -1;
  const singleWorkPanel = workPanelIndices.length === 1;
  const primaryWorkIndex = workPanelIndices[0] ?? 0;
  const settledDuration = formatSettledDuration(
    Math.max(workDurationMs ?? 0, measuredMs ?? 0) || null,
  );

  // If the turn goes quiet after prose with all received text visible and no
  // running step, surface a quiet thinking line after a brief grace window.
  // Restart the timer on every new text chunk or activity so active typing
  // never trips it (with or without smooth text flow).
  const lastBubble = displayBubbles[lastIndex];
  const trailingPaused = useSustained(
    !settled &&
      shownText.length > 0 &&
      shownText.length >= text.length &&
      lastBubble?.segment !== undefined &&
      !activities.some((activity) => activity.status === "now"),
    MID_TURN_PAUSE_MS,
    `${shownText.length}:${activities.length}`,
  );
  const pauseLabel = liveLabel && liveLabel !== "Writing" ? liveLabel : "Thinking";
  const [sawTrailingPause, setSawTrailingPause] = useState(false);
  if (trailingPaused && !sawTrailingPause) setSawTrailingPause(true);

  return (
    <BubbleGroup>
      {displayBubbles.map((bubble, index) => {
        const hasSteps = bubble.leading.length > 0;
        // Before any words or steps arrive on a live turn, bubble 0 shows a quiet,
        // borderless Thinking line. Once prose starts first with no leading steps,
        // it folds smoothly shut; if steps arrive, an enclosed WorkPanel takes over.
        const hostsThinking = index === 0 && !hasSteps && drewLive;
        const thinkingFolded = hostsThinking && (settled || shownText.length > 0);
        const hasFollowingContent = bubble.segment !== undefined || index < lastIndex;
        const panelActive =
          hasSteps &&
          !settled &&
          (bubble.leading.some((step) => step.status === "now") ||
            (!hasFollowingContent && index === lastWorkIndex));
        const panelSettledDuration = settled && singleWorkPanel ? settledDuration : null;
        const cards = bubble.leading.flatMap((activity) =>
          activity.cards ? [{ key: activity.key, node: activity.cards }] : [],
        );
        const steps: readonly WorkPanelStep[] = bubble.leading.map((activity) => ({
          key: activity.key,
          iconKey: activity.iconKey,
          icon: activity.icon,
          isTool: activity.isTool,
          status: activity.status,
          node: activity.node,
        }));
        const hasBodyBelowTop =
          cards.length > 0 ||
          bubble.segment !== undefined ||
          (index === lastIndex && Boolean(trailing));

        return (
          <Bubble
            align="start"
            className={cn(
              "w-full max-w-full gap-2.5",
              index > 0 && (!finalized || flow !== undefined) && "auni-segment-reveal",
            )}
            key={index}
            variant="ghost"
          >
            {hasSteps ? (
              <WorkPanel
                active={panelActive}
                canCollapse={settled || hasFollowingContent}
                key={`work-${index}`}
                liveLabel={liveLabel}
                liveOnMount={!settled}
                primary={primaryWorkIndex === index}
                settledDuration={panelSettledDuration}
                steps={steps}
                workStartedAt={workStartedAt}
              />
            ) : hostsThinking ? (
              <div
                className={cn(
                  "auni-fold w-full min-w-0",
                  thinkingFolded && hasBodyBelowTop && "-mb-2.5",
                )}
                data-folded={thinkingFolded}
                inert={thinkingFolded}
              >
                <div className="min-w-0">
                  <ThinkingIndicator
                    active={!thinkingFolded}
                    animateEnter
                    label={liveLabel ?? "Thinking"}
                    primary
                    startedAt={workStartedAt}
                  />
                </div>
              </div>
            ) : null}

            {cards.length > 0 ? (
              <div className="flex min-w-0 flex-col gap-2">
                {cards.map((card) => (
                  <div key={card.key} className={cn("min-w-0", !settled && "auni-card-enter")}>
                    {card.node}
                  </div>
                ))}
              </div>
            ) : null}

            {bubble.segment !== undefined ? (
              // Its lines break so none ends on a word left alone.
              <BubbleContent className="relative w-full border-0 text-body leading-relaxed text-pretty">
                <MessageResponse
                  isAnimating={index === lastSegmentIndex && (flow?.animating ?? false)}
                >
                  {bubble.segment}
                </MessageResponse>
              </BubbleContent>
            ) : null}

            {index === lastIndex && sawTrailingPause ? (
              <div
                className={cn("auni-fold w-full min-w-0", !trailingPaused && "-mb-2.5")}
                data-folded={!trailingPaused}
                inert={!trailingPaused}
              >
                <div className="min-w-0">
                  <ThinkingIndicator
                    active={trailingPaused}
                    animateEnter
                    label={pauseLabel}
                    startedAt={workStartedAt}
                  />
                </div>
              </div>
            ) : null}

            {index === lastIndex ? trailing : null}
          </Bubble>
        );
      })}
    </BubbleGroup>
  );
}

function layOutBubbles(input: {
  readonly activities: readonly SegmentedBubbleActivity[];
  readonly text: string;
}): readonly BubbleModel[] {
  const bubbles: BubbleModel[] = [];
  let pending: SegmentedBubbleActivity[] = [];
  let cursor = 0;

  // Each run of words between activities is one bubble, without the blank lines at its edges;
  // blank runs (the space between two tool calls) make none, so their activities lead the next.
  const pushRun = (run: string): void => {
    const segment = run.replace(/^\s*\n/u, "").trimEnd();
    if (!segment) return;
    bubbles.push({ leading: pending, runStart: cursor, segment });
    pending = [];
  };

  for (const activity of input.activities) {
    const offset = Math.min(Math.max(activity.offset, cursor), input.text.length);
    pushRun(input.text.slice(cursor, offset));
    pending.push(activity);
    cursor = offset;
  }
  pushRun(input.text.slice(cursor));
  if (pending.length > 0) bubbles.push({ leading: pending, runStart: cursor });
  return bubbles;
}
