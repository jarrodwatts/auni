"use client";

import "../auni-note.css";

import "./pick-detail.css";

import type { ActionRecordId, PickDetailWire } from "@auni/shared";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { AuniNote } from "@/components/cards/auni-note";
import { LogoImage } from "@/components/brand/marks";
import { DawnChart } from "@/components/portfolio/dawn-chart";
import { RollingNumber } from "@/components/portfolio/rolling-number";
import { Skeleton } from "@/components/ui/skeleton";
import { readPickDetail } from "@/lib/data/actions";
import { formatAssetPrice } from "@/lib/money";
import { cn } from "@/lib/utils";

import type { Leg } from "./plan-legs";
import { chartLevels } from "./pick-levels";

/** A pick's line moves slowly; a reopened card reads it from cache. */
const STALE_MS = 5 * 60_000;

function usePickDetail(actionReference: ActionRecordId) {
  return useQuery({
    queryKey: ["pick-detail", actionReference],
    queryFn: ({ signal }) => readPickDetail(actionReference, signal),
    staleTime: STALE_MS,
    retry: false,
  });
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function valueLabel(kind: PickDetailWire["kind"], value: number): string {
  if (kind === "chance") return value < 0.01 ? "Under 1%" : `${Math.round(value * 100)}%`;
  return formatAssetPrice(value);
}

function changeLabel(kind: PickDetailWire["kind"], today: number): string {
  const sign = today >= 0 ? "+" : "";
  return kind === "chance" ? `${sign}${Math.round(today)} pts` : `${sign}${today.toFixed(1)}%`;
}

/** The pick's line, its numbers and Auni's note: the same body on a hover card and in an opened row. */
function PickDetailBody({ leg }: { readonly leg: Leg }) {
  const { data: detail, isPending } = usePickDetail(leg.actionReference);
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubbed = detail && scrub !== null ? detail.points[scrub] : undefined;
  // Made once per reading, so dragging across the chart never redraws its levels.
  const levels = useMemo(() => (detail ? chartLevels(detail.levels, detail.now) : []), [detail]);

  return (
    <div className="flex flex-col">
      {isPending ? (
        <div className="flex flex-col gap-2 px-4 pt-1">
          <Skeleton className="h-7 w-32 rounded-card" />
          <Skeleton className="h-[96px] w-full rounded-card" />
        </div>
      ) : detail ? (
        <div className="auni-pick-settle">
          <div className="flex items-baseline gap-2 px-4">
            <span className="text-card-money text-ink">
              <RollingNumber value={valueLabel(detail.kind, scrubbed?.value ?? detail.now)} />
            </span>
            <span className="text-meta text-muted-foreground tabular-nums">
              {scrubbed ? (
                DATE.format(new Date(scrubbed.at))
              ) : detail.today === null ? (
                detail.kind === "chance" ? (
                  "chance of Yes"
                ) : null
              ) : (
                <>
                  <span className={detail.today >= 0 ? "text-positive" : "text-negative"}>
                    {changeLabel(detail.kind, detail.today)}
                  </span>{" "}
                  today
                </>
              )}
            </span>
          </div>
          <DawnChart
            points={detail.points.map((point) => ({
              at: Date.parse(point.at),
              value: detail.kind === "chance" ? point.value * 100 : point.value,
            }))}
            height={levels.length > 0 ? 132 : 104}
            label={`${leg.name}, last three months`}
            levels={levels}
            onScrub={setScrub}
            className="mt-1"
          />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 px-4 pt-2.5">
            {detail.facts.map((fact, index) => (
              <div
                key={fact.label}
                className="auni-pick-fact min-w-0"
                style={{ "--fact": index } as CSSProperties}
              >
                <dt className="text-caption leading-4 text-muted-foreground">{fact.label}</dt>
                <dd className="truncate text-ui leading-5 font-semibold text-ink tabular-nums">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {/* Only what Auni said: a row's own line, like "Tokenized stock", is no take. */}
      {leg.note ? <AuniNote className="mx-4 mt-4">{leg.note}</AuniNote> : null}
    </div>
  );
}

const CARD_WIDTH = 344;
const GAP = 12;
const EDGE = 12;
/** How far from the pointer the card opens, so it never sits under it. */
const POINTER_GAP = 14;

export interface Anchor {
  /** The pick's row on screen. */
  readonly row: DOMRect;
  /** The list holding the rows, so the card can sit beside it rather than over it. */
  readonly list: DOMRect;
  /** Where the pointer came onto the row, across the screen. */
  readonly x: number;
}

/**
 * Beside the card, level with the pick, where there's room to its right.
 * Otherwise it opens from where they pointed: just right of the pointer (left
 * of it near the screen's edge), under the pick, or over it near the bottom.
 * It grows out of that point.
 */
function place(anchor: Anchor, height: number): { x: number; y: number; origin: string } {
  const { row, list, x: pointer } = anchor;
  const clampY = (top: number) => Math.max(Math.min(top, innerHeight - height - EDGE), EDGE);
  if (list.right + GAP + CARD_WIDTH + EDGE <= innerWidth) {
    const y = clampY(row.top - 14);
    return { x: list.right + GAP, y, origin: `0 ${row.top + row.height / 2 - y}px` };
  }
  const right = pointer + POINTER_GAP;
  const x =
    right + CARD_WIDTH + EDGE <= innerWidth
      ? right
      : Math.max(pointer - POINTER_GAP - CARD_WIDTH, EDGE);
  const below = row.bottom + 6;
  const fitsBelow = below + height + EDGE <= innerHeight;
  const y = fitsBelow ? below : Math.max(row.top - 6 - height, EDGE);
  return { x, y, origin: `${Math.round(pointer - x)}px ${fitsBelow ? 0 : height}px` };
}

/**
 * The card a hovered pick opens on a pointer device. One card serves the whole
 * list: moving to another pick glides it there and cross-fades what it says.
 */
export function PickHoverCard({
  id,
  leg,
  anchor,
  closing,
  onEnter,
  onLeave,
}: {
  readonly id: string;
  readonly leg: Leg | null;
  readonly anchor: Anchor | null;
  /** On its way out: it fades where it is, then goes. */
  readonly closing: boolean;
  readonly onEnter: () => void;
  readonly onLeave: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(360);
  // Shown once and moved since: only then does it glide rather than appear.
  const [settled, setSettled] = useState(false);
  const shown = leg !== null && anchor !== null;

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize[0];
      if (size) setHeight(Math.round(size.blockSize));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);

  // Back to appearing, rather than gliding, each time it closes.
  const [wasShown, setWasShown] = useState(shown);
  if (shown !== wasShown) {
    setWasShown(shown);
    if (!shown) setSettled(false);
  }

  if (!shown || typeof document === "undefined") return null;
  const spot = place(anchor, height);
  return createPortal(
    <div
      ref={box}
      id={id}
      role="tooltip"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      data-gliding={settled || undefined}
      data-closing={closing || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setSettled(true);
      }}
      className="auni-pick-card auni-scrollbar-none fixed top-0 left-0 z-50 max-h-[calc(100dvh-24px)] w-[344px] overflow-x-hidden overflow-y-auto rounded-sheet bg-popover pt-4 pb-3.5 border border-border shadow-float"
      style={{
        transform: `translate3d(${spot.x}px, ${spot.y}px, 0)`,
        transformOrigin: spot.origin,
      }}
    >
      <div key={leg.actionReference} className="auni-pick-swap">
        <div className="flex items-center gap-2.5 px-4 pb-2.5">
          {leg.logoUrl ? <LogoImage fallback={null} size={28} src={leg.logoUrl} /> : null}
          <p className="min-w-0 flex-1 truncate text-body leading-5 font-semibold tracking-[-0.01em] text-ink">
            {leg.name}
          </p>
        </div>
        <PickDetailBody leg={leg} />
      </div>
    </div>,
    document.body,
  );
}

/** A tapped pick on a touch screen opens the same detail inside its row. */
export function PickInline({ leg, open }: { readonly leg: Leg; readonly open: boolean }) {
  // Once opened it stays drawn, so closing folds it away rather than emptying it first.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return (
    <div className={cn("auni-pick-inline", open && "is-open")} aria-hidden={!open}>
      <div className="min-h-0 overflow-hidden">
        <div className="-mx-3.5 pt-3 pb-1">{opened ? <PickDetailBody leg={leg} /> : null}</div>
      </div>
    </div>
  );
}
