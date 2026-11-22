"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import type { TextFlowView } from "@/components/conversation/use-text-flow";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  formatWorkDuration,
  useWorkClock,
  workHistoryLabel,
} from "@/components/conversation/work-clock";
import { AutoHeight } from "@/components/motion/auto-height";
import { TextSwap } from "@/components/motion/text-swap";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { cn } from "@/lib/utils";

/** Tool or skill activity rendered in its place: after `offset` characters of the text. */
interface SegmentedBubbleActivity {
  readonly key: string;
  readonly offset: number;
  readonly node: ReactNode;
  readonly foldsText?: boolean;
  /** Cards stay mounted and visible at their originating activity. */
  readonly cards?: ReactNode;
}

interface SegmentedBubblesProps {
  readonly text: string;
  /** Core's measurement of the finished turn; the settled trigger reports it. */
  readonly workDurationMs?: number | undefined;
  /** When the request was sent; the live trigger counts up from it. */
  readonly workStartedAt?: string | undefined;
  /** What the live turn is doing, said in the line over its work. */
  readonly liveLabel?: string | null;
  /**
   * The live label names a step under way or a thought being had, which its own row says too
   * while the steps are open: the line over them then only says the turn is working.
   */
  readonly liveLabelIsStep?: boolean;
  /** Keep action explanations alongside their cards when work is collapsed. */
  readonly preserveText?: boolean;
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
  liveLabelIsStep = false,
  preserveText = false,
  text,
  trailing,
  workDurationMs,
  workStartedAt,
}: SegmentedBubblesProps) {
  const [expansion, setExpansion] = useState<{ fold: number; open: boolean }>();
  const historyId = useId();
  const settled =
    finalized && (flow === undefined || (flow.visibleLength >= text.length && !flow.animating));
  const elapsedMs = useWorkClock({ active: !settled, startedAt: workStartedAt });
  // A turn that drew its work line live keeps it once settled, so finishing never
  // takes a row out from over the answer.
  const [drewLive, setDrewLive] = useState(!settled);
  if (!settled && !drewLive) setDrewLive(true);
  const shownText = flow === undefined ? text : text.slice(0, flow.visibleLength);
  const bubbles = layOutBubbles({
    activities:
      flow === undefined
        ? activities
        : activities.filter((activity) => activity.offset <= shownText.length),
    text: shownText,
  });

  const hasWork = bubbles.some((bubble) => bubble.leading.length > 0);
  // Settled, a turn that did nothing to show and was done within a second worked on nothing
  // worth a line over it.
  const worked = !settled || Math.max(workDurationMs ?? 0, elapsedMs ?? 0) >= 1_000;
  const showsWorkLine = hasWork || (drewLive && worked);

  if (bubbles.length === 0) {
    return (
      <>
        {showsWorkLine ? (
          <WorkLine
            elapsedMs={elapsedMs}
            liveLabel={liveLabel}
            settled={settled}
            workDurationMs={workDurationMs}
          />
        ) : null}
        <Bubble align="start" className="w-full max-w-full" variant="ghost">
          {trailing}
        </Bubble>
      </>
    );
  }

  const lastIndex = bubbles.length - 1;
  const lastSegmentIndex = bubbles.findLastIndex((bubble) => bubble.segment !== undefined);
  const passed = (bubble: BubbleModel): boolean => settled || bubble.runStart < shownText.length;
  // Work folds under the words that follow it; with no words at all it stays in view.
  const workFold =
    lastSegmentIndex < 0
      ? -1
      : bubbles.findLastIndex((bubble) => bubble.leading.length > 0 && passed(bubble));
  const foldBoundary = Math.min(
    bubbles.findLastIndex(
      (bubble) => passed(bubble) && bubble.leading.some((activity) => activity.foldsText !== false),
    ),
    lastSegmentIndex,
  );
  const toggled = expansion !== undefined && expansion.fold === workFold;
  const open = toggled ? expansion.open : workFold < 0;
  const foldedThrough = open ? -1 : toggled ? lastIndex : workFold;
  return (
    <>
      {showsWorkLine ? (
        <WorkLine
          controls={historyId}
          elapsedMs={elapsedMs}
          liveLabel={open && hasWork && liveLabelIsStep ? WORKING : liveLabel}
          onToggle={hasWork ? () => setExpansion({ fold: workFold, open: !open }) : undefined}
          open={open}
          settled={settled}
          workDurationMs={workDurationMs}
        />
      ) : null}
      <BubbleGroup id={historyId}>
        {bubbles.map((bubble, index) => {
          const showWork = index > foldedThrough;
          const showText = showWork || !hasWork || preserveText || index >= foldBoundary;
          const hasVisibleContent =
            showWork ||
            bubble.leading.some((activity) => Boolean(activity.cards)) ||
            (showText && bubble.segment !== undefined) ||
            (index === lastIndex && trailing);
          return (
            <Bubble
              align="start"
              className={cn(
                "w-full max-w-full gap-2",
                !hasVisibleContent && "hidden",
                // Entrance animation only for bubbles appearing under a live
                // cursor; a finalized history render mounts everything statically.
                index > 0 && (!finalized || flow !== undefined) && "auni-segment-reveal",
              )}
              key={index}
              variant="ghost"
            >
              {bubble.leading.length > 0 ? (
                // One flat list of steps; only a card puts space between them. A step or
                // card arriving live opens its room as it rises in, rather than in one frame.
                <AutoHeight className="min-w-0">
                  <div className="flex min-w-0 flex-col">
                    {bubble.leading.map((activity) => (
                      <div
                        key={activity.key}
                        className={cn("min-w-0", activity.cards && "not-last:mb-2")}
                      >
                        {activity.node !== null ? (
                          // Folding closes the steps rather than dropping them, so the
                          // words that follow slide up into their place.
                          <div className="auni-fold" data-folded={!showWork} inert={!showWork}>
                            <div className={cn(!settled && "auni-stagger-in")}>{activity.node}</div>
                          </div>
                        ) : null}
                        {activity.cards ? (
                          <div className={cn(!settled && "auni-stagger-in")}>{activity.cards}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </AutoHeight>
              ) : null}
              {bubble.segment !== undefined ? (
                // Its lines break so none ends on a word left alone.
                <BubbleContent
                  className={cn(
                    "relative w-full border-0 text-[15px] leading-relaxed text-pretty",
                    !showText && "hidden",
                  )}
                >
                  <MessageResponse
                    isAnimating={index === lastSegmentIndex && (flow?.animating ?? false)}
                  >
                    {bubble.segment}
                  </MessageResponse>
                </BubbleContent>
              ) : null}
              {index === lastIndex ? trailing : null}
            </Bubble>
          );
        })}
      </BubbleGroup>
    </>
  );
}

const WORKING = "Working…";

/**
 * The one line over a turn's work, from the send to long after: what it is doing and
 * for how long while it runs, then how long it worked. Its size never changes, only what
 * it holds, so nothing under it moves as the turn goes from one moment to the next.
 */
function WorkLine({
  controls,
  elapsedMs,
  liveLabel,
  onToggle,
  open = false,
  settled,
  workDurationMs,
}: {
  readonly controls?: string;
  readonly elapsedMs: number | null;
  readonly liveLabel?: string | null | undefined;
  readonly onToggle?: (() => void) | undefined;
  readonly open?: boolean;
  readonly settled: boolean;
  readonly workDurationMs: number | undefined;
}) {
  const label = settled ? workHistoryLabel({ elapsedMs, workDurationMs }) : (liveLabel ?? WORKING);
  return (
    <button
      aria-controls={onToggle ? controls : undefined}
      aria-expanded={onToggle ? open : undefined}
      className="mb-3 flex h-10 w-full min-w-0 items-center gap-2 border-b border-border/60 pb-2 text-left text-[14px] text-muted-foreground outline-none enabled:hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      data-slot="work-history-trigger"
      disabled={!onToggle}
      onClick={onToggle}
      type="button"
    >
      {/* Only what it is doing is announced; the clock ticks for the eye alone. */}
      <span aria-live={settled ? undefined : "polite"} className="min-w-0">
        <TextSwap className={settled ? undefined : "shimmer shimmer-duration-1500"} text={label} />
      </span>
      {onToggle ? (
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 flex-none transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
          strokeWidth={1.5}
        />
      ) : null}
      {settled ? null : (
        <span
          aria-hidden
          className="ml-auto flex-none text-[13px] text-muted-foreground/80 tabular-nums"
        >
          {elapsedMs === null || elapsedMs < 1_000 ? "0s" : formatWorkDuration(elapsedMs)}
        </span>
      )}
    </button>
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
