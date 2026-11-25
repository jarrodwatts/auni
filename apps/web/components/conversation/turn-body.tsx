"use client";

import { useState, type ReactNode } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { ThinkingIndicator } from "@/components/conversation/thinking-indicator";
import type { TextFlowView } from "@/components/conversation/use-text-flow";
import { useSustained } from "@/lib/use-sustained";
import { cn } from "@/lib/utils";

import { turnBlocks } from "./turn-model";
import { ThoughtRail, TurnSteps, type TurnStep } from "./turn-work";

/** Mid-turn quiet, with nothing visibly under way, before a thinking line shows. */
const MID_TURN_PAUSE_MS = 700;

/** Something Auni did while answering, in its place: after `offset` characters of the words. */
export interface TurnActivity {
  readonly key: string;
  readonly offset: number;
  /** A thought: its words, shown whole on a rail. */
  readonly thought?: string;
  /** A step: a tool it ran. */
  readonly step?: TurnStep;
  /** The cards a step put up, which stay where it put them. */
  readonly cards?: ReactNode;
}

interface Segment {
  readonly leading: readonly TurnActivity[];
  readonly words?: string;
}

/**
 * An answer as it happened: its thoughts, the steps it took and the cards they put up, and its
 * words, each in the place it came. While it runs, it says what it's doing: a thinking line
 * before anything arrives, a thought growing on a blue rail, a step under way with its mark.
 */
export function TurnBody({
  activities = [],
  finalized,
  flow,
  liveLabel,
  text,
  trailing,
}: {
  readonly text: string;
  /** What the live turn is doing, said while it thinks with nothing else to show. */
  readonly liveLabel?: string | null;
  /** True once the turn is over; it then draws still. */
  readonly finalized: boolean;
  readonly flow?: TextFlowView;
  /** What it did, in the order it did it, each placed by the words before it. */
  readonly activities?: readonly TurnActivity[];
  /** After everything: the answer's closing cards and notices. */
  readonly trailing?: ReactNode;
}) {
  const settled =
    finalized && (flow === undefined || (flow.visibleLength >= text.length && !flow.animating));
  // An answer seen live folds its first thinking line away when something arrives, rather
  // than dropping it in one frame; one read from history never had one.
  const [drewLive, setDrewLive] = useState(!settled);
  if (!settled && !drewLive) setDrewLive(true);

  const shownText = flow === undefined ? text : text.slice(0, flow.visibleLength);
  const shownActivities =
    flow === undefined
      ? activities
      : activities.filter((activity) => activity.offset <= shownText.length);
  const segments = layOut(shownActivities, shownText);
  const lastIndex = segments.length - 1;
  const lastWordsIndex = segments.findLastIndex((segment) => segment.words !== undefined);
  const lastActivity = shownActivities.at(-1);
  const lastIsWords = segments.at(-1)?.words !== undefined;
  const anyRunning = shownActivities.some(({ step }) => step?.status === "now");
  // The newest thought is live while nothing has come after it.
  const liveThought =
    !settled && !lastIsWords && lastActivity?.thought !== undefined ? lastActivity.key : null;

  // Quiet with nothing visibly under way (words caught up, no step running, no thought
  // growing): after a beat, a thinking line says Auni is still at it.
  const somethingShown = shownText.length > 0 || shownActivities.length > 0;
  const paused = useSustained(
    !settled && somethingShown && shownText.length >= text.length && !anyRunning && !liveThought,
    MID_TURN_PAUSE_MS,
    `${shownText.length}:${shownActivities.length}`,
  );
  const [sawPause, setSawPause] = useState(false);
  if (paused && !sawPause) setSawPause(true);
  const pauseLabel = liveLabel && liveLabel !== "Writing" ? liveLabel : "Thinking";

  return (
    <div className="flex min-w-0 flex-col gap-3" data-slot="turn-body">
      {drewLive ? (
        // Before anything of the answer arrives: one quiet line, folding away once it does.
        <div
          className={cn("auni-fold", somethingShown || settled ? "-mb-3" : undefined)}
          data-folded={somethingShown || settled}
          inert={somethingShown || settled}
        >
          <div className="min-w-0">
            <ThinkingIndicator
              active={!somethingShown && !settled}
              label={liveLabel ?? "Thinking"}
            />
          </div>
        </div>
      ) : null}

      {segments.map((segment, index) => {
        const blocks = turnBlocks<TurnActivity, TurnActivity>(
          segment.leading.map((activity) =>
            activity.thought !== undefined ? { thought: activity } : { step: activity },
          ),
        );
        const followed = settled || segment.words !== undefined || index < lastIndex;
        return (
          <div
            key={index}
            className={cn(
              "flex min-w-0 flex-col gap-3",
              index > 0 && !settled && "auni-segment-reveal",
            )}
          >
            {blocks.map((block, blockIndex) => {
              const over = followed || blockIndex < blocks.length - 1;
              if (block.kind === "thought")
                return (
                  <ThoughtRail
                    key={block.thought.key}
                    live={block.thought.key === liveThought}
                    text={block.thought.thought ?? ""}
                  />
                );
              const cards = block.steps.flatMap((activity) =>
                activity.cards ? [{ key: activity.key, node: activity.cards }] : [],
              );
              return (
                <div key={block.steps[0]!.key} className="flex min-w-0 flex-col gap-3">
                  <TurnSteps
                    over={over}
                    steps={block.steps.flatMap(({ step }) => (step ? [step] : []))}
                  />
                  {cards.map((card) => (
                    <div key={card.key} className={cn("min-w-0", !settled && "auni-card-enter")}>
                      {card.node}
                    </div>
                  ))}
                </div>
              );
            })}

            {segment.words !== undefined ? (
              // Its lines break so none ends on a word left alone.
              <div className="auni-answer min-w-0 text-reading text-pretty text-foreground">
                <MessageResponse
                  isAnimating={index === lastWordsIndex && (flow?.animating ?? false)}
                >
                  {segment.words}
                </MessageResponse>
              </div>
            ) : null}
          </div>
        );
      })}

      {sawPause ? (
        <div className={cn("auni-fold", !paused && "-mb-3")} data-folded={!paused} inert={!paused}>
          <div className="min-w-0">
            <ThinkingIndicator active={paused} label={pauseLabel} />
          </div>
        </div>
      ) : null}

      {trailing}
    </div>
  );
}

/**
 * Each run of words, with what Auni did before it leading it. Blank runs (the space between two
 * steps) make none, so their activities lead the next run; what came after the last words ends
 * the answer on its own.
 */
function layOut(activities: readonly TurnActivity[], text: string): readonly Segment[] {
  const segments: Segment[] = [];
  let leading: TurnActivity[] = [];
  let cursor = 0;
  const pushRun = (run: string): void => {
    const words = run.replace(/^\s*\n/u, "").trimEnd();
    if (!words) return;
    segments.push({ leading, words });
    leading = [];
  };
  for (const activity of activities) {
    const offset = Math.min(Math.max(activity.offset, cursor), text.length);
    pushRun(text.slice(cursor, offset));
    leading.push(activity);
    cursor = offset;
  }
  pushRun(text.slice(cursor));
  if (leading.length > 0) segments.push({ leading });
  return segments;
}
