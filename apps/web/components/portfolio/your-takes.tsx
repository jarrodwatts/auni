"use client";

import { listed, type ActivityItemWire, type ThreadId } from "@auni/shared";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { amountText, TONE_CLASS_NAME } from "@/components/activity/activity-groups";
import { useStartNew } from "@/components/app/use-start-conversation";
import { AssetLogo } from "@/components/brand/marks";
import { PlaceLink } from "@/components/places/open-place";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Row } from "@/components/ui/row";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { chatHref } from "@/lib/app-links";
import type { Take } from "@/lib/data/takes";
import { formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";

import { HoldingRow, RowButton } from "./holding-groups";
import { takeTimeline } from "./money-groups";
import { TakeChange } from "./take-change";

/**
 * Each take as one row: what it holds, what that is worth, and what it made since it was
 * bought. Opening one shows its holdings and the moves that built it, each opening its receipt.
 */
export function YourTakes({
  takes,
  failed,
  moves,
  openTake,
  onOpenMove,
}: {
  /** Null until read. */
  readonly takes: readonly Take[] | null;
  readonly failed: boolean;
  /** Every move, newest first. */
  readonly moves: readonly ActivityItemWire[];
  /** A take to open as the page loads (a link from its chat). */
  readonly openTake: ThreadId | null;
  readonly onOpenMove: (move: ActivityItemWire) => void;
}) {
  const startNew = useStartNew();
  return (
    <Section
      heading="Your takes"
      aria-label="Your takes"
      action={
        <Link
          href="/app/new"
          onClick={startNew}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          New take
        </Link>
      }
    >
      {failed ? (
        <p className="text-ui text-muted-foreground">
          Your takes couldn&apos;t be read just now. Your money above is all there.
        </p>
      ) : takes === null ? (
        <Skeleton className="h-[148px] w-full rounded-card" />
      ) : takes.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          No takes yet. Tell Auni what you think will happen, and the positions it builds group
          here.
        </p>
      ) : (
        <Card className="divide-y divide-border">
          {takes.map((take) => (
            <TakeRow
              key={take.threadId}
              take={take}
              moves={moves}
              initiallyOpen={take.threadId === openTake}
              onOpenMove={onOpenMove}
            />
          ))}
        </Card>
      )}
    </Section>
  );
}

function TakeRow({
  take,
  moves,
  initiallyOpen,
  onOpenMove,
}: {
  readonly take: Take;
  readonly moves: readonly ActivityItemWire[];
  readonly initiallyOpen: boolean;
  readonly onOpenMove: (move: ActivityItemWire) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The page's own scroller, never the layout around it, brings the take to the top.
    const node = row.current;
    const scroller = node?.closest("[data-money-scroller]");
    if (!initiallyOpen || !node || !scroller) return;
    const gap = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += gap - 16;
  }, [initiallyOpen]);
  const panel = `take-${take.threadId}`;
  return (
    <div ref={row}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="block w-full px-4 text-left outline-none transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] sm:px-5"
      >
        <Row
          className="min-h-16"
          mark={<LogoStack take={take} />}
          title={<span className="text-body">{take.title}</span>}
          meta={listed(take.holdings.map(({ name }) => name))}
          end={
            <>
              <span className="flex flex-col items-end">
                <span className="text-body font-semibold tabular-nums">
                  {formatUsdcBalance(take.value)}
                </span>
                {take.change ? <TakeChange change={take.change} className="text-meta" /> : null}
              </span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "size-4 text-faint transition-transform duration-200 ease-settle motion-reduce:transition-none max-sm:hidden",
                  open && "rotate-180",
                )}
              />
            </>
          }
        />
      </button>
      <div
        id={panel}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-settle motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <TakeInside take={take} moves={moves} onOpenMove={onOpenMove} />
        </div>
      </div>
    </div>
  );
}

/** Up to two of a take's logos, overlapping, the largest holding in front. */
function LogoStack({ take }: { readonly take: Take }) {
  const shown = take.holdings.slice(0, 2);
  return (
    <span className="flex w-14 flex-none items-center">
      {shown.map((holding, index) => (
        <span
          key={holding.id}
          className={cn("flex rounded-full ring-2 ring-card", index > 0 && "-ml-2.5")}
          style={{ zIndex: shown.length - index }}
        >
          <AssetLogo holding={holding} size={shown.length === 1 ? 36 : 30} />
        </span>
      ))}
    </span>
  );
}

function TakeInside({
  take,
  moves,
  onOpenMove,
}: {
  readonly take: Take;
  readonly moves: readonly ActivityItemWire[];
  readonly onOpenMove: (move: ActivityItemWire) => void;
}) {
  const [all, setAll] = useState(false);
  const timeline = takeTimeline(moves, take.threadId);
  const shown = all
    ? moves.filter((move) => move.threadId === take.threadId).toReversed()
    : timeline.moves;
  return (
    <div className="px-4 pb-4 sm:px-5">
      <ul className="divide-y divide-border border-t border-border">
        {take.holdings.map((holding) => (
          <li key={holding.id}>
            <HoldingRow holding={holding} />
          </li>
        ))}
      </ul>
      {shown.length > 0 ? (
        <>
          <h3 className="mt-4 mb-1 text-caption font-medium text-muted-foreground">
            How it was built
          </h3>
          <ol>
            {shown.map((move, index) => (
              <li key={move.id}>
                <TimelineMove
                  move={move}
                  last={index === shown.length - 1}
                  onOpen={() => onOpenMove(move)}
                />
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PlaceLink
          href={chatHref(take.threadId)}
          thread={take.threadId}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          View chat
        </PlaceLink>
        {!all && timeline.earlier > 0 ? (
          <button
            type="button"
            onClick={() => setAll(true)}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            {timeline.earlier === 1
              ? "Show 1 earlier move"
              : `Show ${timeline.earlier} earlier moves`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** One move on a take's rail: when, what, and for how much; it opens its receipt. */
function TimelineMove({
  move,
  last,
  onOpen,
}: {
  readonly move: ActivityItemWire;
  readonly last: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <RowButton onClick={onOpen}>
      {last ? null : (
        <span aria-hidden className="absolute top-1/2 -bottom-1/2 left-[13px] w-px bg-border" />
      )}
      <Row
        className="min-h-12 py-2"
        mark={
          <span
            aria-hidden
            className="relative flex size-2.5 rounded-full border-2 border-ink bg-card"
          />
        }
        title={move.title}
        meta={DAY.format(new Date(move.at))}
        end={
          move.amount ? (
            <span className={cn("tabular-nums", TONE_CLASS_NAME[move.amount.tone])}>
              {amountText(move.amount)}
            </span>
          ) : null
        }
      />
    </RowButton>
  );
}
