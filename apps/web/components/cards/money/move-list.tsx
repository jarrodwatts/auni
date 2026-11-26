"use client";

import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { LogoImage } from "@/components/brand/marks";
import { StatusMark } from "@/components/motion/status-mark";
import { TextSwap } from "@/components/motion/text-swap";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { durations, easings, reducedMotion } from "@/lib/motion";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import type { Leg } from "./plan-legs";
import {
  failedStep,
  onlyWhileNewest,
  placedActions,
  type FailedAction,
  type FailedStep,
} from "./failed-step";
import { Late, MarkFace } from "./money-card-parts";
import styles from "./money-card.module.css";
import { overall, shownRows, spotlit, type MoveRow } from "./move-rows";
import { PickHoverCard, PickInline, type Anchor } from "./pick-detail";
import { restLabel } from "./pick-money";

const MARK = 36;
/** Each row's hover wash reaches 14px past its content; the list gives that back at its edges. */
const ROW = "-mx-3.5 rounded-card px-3.5 py-2";
const MORE = "more";

/** What a card's steps that didn't go through say and offer, and what a tap on one does. */
export interface Failed {
  readonly steps: ReadonlyMap<string, FailedStep>;
  readonly act: (step: {
    readonly key: string;
    readonly label: string;
    readonly reason: string;
  }) => (action: FailedAction) => void;
  /** The tap core is answering now, whose button says so while the others wait. */
  readonly busy: FailedAction | null;
  /** Why the last Try again didn't run, or what a Check status found, said beside it. */
  readonly problem: string | null;
}

/**
 * Everything a card does with the money, one row each, in the order it runs:
 * what it is, what it moves, and where it stands. A soft spotlight rests on
 * the row happening now and glides to the next as each lands; what's still to
 * come sits back. A row that didn't go through says why and where the money
 * is, with what can help beside it. A pick's whole story opens on hover, or
 * in its row on a tap.
 */
export function MoveList({
  failed = null,
  rows,
}: {
  /** What its failed rows offer, once nothing on the card still runs; null offers nothing yet. */
  readonly failed?: Failed | null;
  readonly rows: readonly MoveRow[];
}) {
  const [all, setAll] = useState(false);
  const count = all ? rows.length : shownRows(rows);
  const cut = count < rows.length;
  const shown = rows.slice(0, count);
  const rest = rows.slice(count);
  const {
    list,
    setList,
    enabled,
    peek,
    leave,
    stay,
    leg: peeked,
    anchor,
    closing,
  } = usePickHover();
  const cardId = useId();
  const target = spotlit(rows);
  // A row behind "N more" is lit on that row.
  const lit = target === null || shown.some((row) => row.key === target) ? target : MORE;
  // Once the card is under way, what's still to come sits back.
  const begun = rows.some((row) => row.status !== "waiting");
  // Each failed row's reason, and once the card has settled, each thing to do once, on the first
  // row offering it.
  const steps = rows.flatMap((row) =>
    row.failure
      ? [[row.key, failed?.steps.get(row.key) ?? failedStep(row.failure, null, false)] as const]
      : [],
  );
  const offered = failed ? placedActions(steps) : new Map<string, readonly FailedAction[]>();
  const reasons = new Map(steps);
  const now = rows.find((row) => row.status === "now");
  return (
    <>
      <p aria-live="polite" className="sr-only" role="status">
        {now?.label ?? ""}
      </p>
      <ul ref={setList} className="relative isolate -my-2 flex flex-col">
        {shown.map((row) => (
          <Row
            key={row.key}
            row={row}
            begun={begun}
            hoverable={enabled}
            described={peeked && peeked.actionReference === row.key ? cardId : undefined}
            onPeek={(element, at, x) => row.pick && peek(row.pick, element, at, x)}
            onUnpeek={leave}
            failure={
              row.failure
                ? {
                    reason: reasons.get(row.key)?.reason ?? "",
                    actions: offered.get(row.key) ?? [],
                    onAct: (action) =>
                      failed?.act({
                        key: row.key,
                        label: row.label,
                        reason: reasons.get(row.key)?.reason ?? "",
                      })(action),
                    busy: failed?.busy ?? null,
                    calm: row.failure.held === true,
                    problem: offered
                      .get(row.key)
                      ?.some((action) => action === "retry" || action === "check")
                      ? (failed?.problem ?? null)
                      : null,
                  }
                : null
            }
          />
        ))}
        <PickHoverCard
          id={cardId}
          leg={peeked}
          anchor={anchor}
          closing={closing}
          onEnter={stay}
          onLeave={leave}
        />
        {cut ? (
          <li>
            <button
              type="button"
              data-row={MORE}
              onClick={() => setAll(true)}
              className={cn(
                ROW,
                "group relative flex w-[calc(100%+28px)] items-center gap-3 text-left outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              <span
                className="flex flex-none items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground"
                style={{ width: MARK, height: MARK }}
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1 text-body font-medium text-muted-foreground transition-colors group-hover:text-ink">
                {rest.length} more
              </span>
              <span className="flex-none text-body font-semibold text-muted-foreground tabular-nums">
                {restLabel(rest.flatMap((row) => (row.pick ? [row.pick] : [])))}
              </span>
              {begun ? <StatusMark status={overall(rest)} /> : null}
            </button>
          </li>
        ) : null}
        <Spotlight list={list} target={lit} />
      </ul>
    </>
  );
}

function Row({
  begun,
  described,
  failure,
  hoverable,
  onPeek,
  onUnpeek,
  row,
}: {
  /**
   * The card is under way: each row shows where it stands, and what's still to come sits back.
   * Before, a row shows no mark, which would read as a box to untick.
   */
  readonly begun: boolean;
  /** The open card's id while it describes this pick. */
  readonly described: string | undefined;
  /** Why it didn't go through, and what to do about it. */
  readonly failure: FailedLine | null;
  /** A pointer device: a pick's detail opens as a card beside it rather than in the row. */
  readonly hoverable: boolean;
  readonly onPeek: (row: HTMLElement, now: boolean, pointerX?: number) => void;
  readonly onUnpeek: () => void;
  readonly row: MoveRow;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const quiet = begun && row.status === "waiting";
  const { pick } = row;
  const words = (
    <>
      {/* On a phone a row wraps, never cut: where its money goes, what it opens, when it's gone. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-body leading-5 font-medium tracking-[-0.01em] text-ink">
        <span className="flex min-w-0">
          <TextSwap
            className={row.status === "now" ? styles.shimmer : undefined}
            text={row.label}
            wrap
          />
        </span>
        {row.tags.map((tag) => (
          <Badge key={tag.text}>{tag.text}</Badge>
        ))}
      </span>
      {row.line ? (
        <span
          className={cn("mt-0.5 block text-meta leading-[18px] text-pretty text-muted-foreground")}
        >
          {row.line}
          {row.result ? (
            <>
              {", "}
              <span className={row.result.down ? "text-negative" : "text-positive"}>
                {row.result.text}
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </>
  );
  return (
    // The mark leads the row so a fresh card's reveal can land each logo on its own.
    <li
      ref={rowRef}
      data-row={row.key}
      // Only a pointer moving onto a pick opens it, never one a card lands under as it comes in.
      onPointerMove={(event) => {
        if (pick && event.pointerType === "mouse" && (event.movementX || event.movementY))
          onPeek(event.currentTarget, false, event.clientX);
      }}
      onPointerLeave={(event) => {
        if (pick && event.pointerType === "mouse") onUnpeek();
      }}
      className={cn(
        ROW,
        "relative flex flex-wrap items-center gap-x-3 transition-[opacity,background-color] duration-400 ease-settle",
        pick && "hover:bg-foreground/[0.03]",
        quiet && "opacity-50",
      )}
    >
      {row.logo ? (
        <span className="relative flex flex-none">
          <MarkFace mark={row.logo} size={MARK} />
          {row.badge ? (
            <LogoImage
              className="absolute -right-1 -bottom-1 shadow-[0_0_0_2px_var(--card)]"
              fallback={null}
              size={16}
              src={row.badge}
            />
          ) : null}
        </span>
      ) : null}
      {pick ? (
        <button
          type="button"
          aria-expanded={open}
          aria-describedby={described}
          onClick={() => setOpen((value) => !value)}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible") && rowRef.current)
              onPeek(rowRef.current, true);
          }}
          onBlur={onUnpeek}
          className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
        >
          {words}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{words}</div>
      )}
      {/* Centered on the whole row, so the amount reads as the row's value, not the name's. */}
      {row.meta ? (
        <span className="flex-none self-center text-body leading-5 font-semibold tracking-[-0.01em] text-ink tabular-nums">
          <TextSwap text={row.meta} />
        </span>
      ) : row.status === "now" ? (
        <Late />
      ) : null}
      {begun ? <StatusMark status={row.status} /> : null}
      {failure ? (
        <div
          className={cn(
            "relative mt-1.5 flex basis-full flex-wrap items-center gap-x-3 gap-y-2",
            row.logo && "pl-12",
          )}
        >
          {/* A held step hasn't failed, so it says where it stands calmly. */}
          <p
            className={cn(
              "min-w-0 flex-1 basis-48 text-meta leading-[18px] text-pretty",
              failure.calm ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {failure.problem ?? failure.reason}
          </p>
          <FailedActions actions={failure.actions} busy={failure.busy} onAct={failure.onAct} />
        </div>
      ) : null}
      {/* A touch screen has no hover: a tap opens the pick's detail in its row. */}
      {pick && !hoverable ? (
        <div className="basis-full">
          <PickInline leg={pick} open={open} />
        </div>
      ) : null}
    </li>
  );
}

interface FailedLine {
  readonly reason: string;
  readonly actions: readonly FailedAction[];
  readonly onAct: (action: FailedAction) => void;
  readonly busy: FailedAction | null;
  /** A held step's words, which aren't a failure's. */
  readonly calm: boolean;
  readonly problem: string | null;
}

const ACTION_LABEL: Record<FailedAction, string> = {
  retry: "Try again",
  add_money: "Add money",
  ask: "Ask Auni",
  check: "Check status",
  close: "Dismiss card",
  keep: "Keep checking",
};
/** What a button says while core answers its tap. */
const BUSY_LABEL: Partial<Record<FailedAction, string>> = {
  retry: "Trying again",
  check: "Checking",
  close: "Dismissing",
};

/** What can help a step that didn't go through, most helpful first: the first one in ink. */
export function FailedActions({
  actions,
  onAct,
  busy,
}: {
  readonly actions: readonly FailedAction[];
  readonly onAct: (action: FailedAction) => void;
  readonly busy: FailedAction | null;
}) {
  if (actions.length === 0) return null;
  return (
    // Gone with its buttons once the conversation moves on, so it holds no place in its row.
    <span
      className={cn(
        "flex max-w-full flex-none flex-wrap items-center gap-2",
        actions.every(onlyWhileNewest) && styles.whileNewest,
      )}
    >
      {actions.map((action, index) => (
        <button
          key={action}
          type="button"
          disabled={busy !== null}
          onClick={() => onAct(action)}
          data-testid={`step-${action}`}
          data-check-status={action === "check" ? "" : undefined}
          className={cn(
            onlyWhileNewest(action) && styles.whileNewest,
            buttonVariants({ size: "sm", variant: index === 0 ? "primary" : "secondary" }),
            "font-semibold disabled:opacity-60",
          )}
        >
          <TextSwap
            text={(busy === action ? BUSY_LABEL[action] : undefined) ?? ACTION_LABEL[action]}
          />
        </button>
      ))}
    </span>
  );
}

/**
 * A soft surface under the row being worked on, gliding to the next as each
 * one lands, and fading when nothing is. It follows its row as rows above it
 * open or close.
 */
function Spotlight({
  list,
  target,
}: {
  readonly list: HTMLUListElement | null;
  readonly target: string | null;
}) {
  const spot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = spot.current;
    if (!list || !element) return undefined;
    let glide: Animation | null = null;
    const place = () => {
      const row =
        target === null
          ? null
          : list.querySelector<HTMLElement>(`[data-row="${CSS.escape(target)}"]`);
      const now = getComputedStyle(element);
      const at = {
        top: now.top,
        left: now.left,
        width: now.width,
        height: now.height,
        opacity: now.opacity,
      };
      const to = row
        ? {
            top: `${row.offsetTop}px`,
            left: `${row.offsetLeft}px`,
            width: `${row.offsetWidth}px`,
            height: `${row.offsetHeight}px`,
            opacity: "1",
          }
        : { ...at, opacity: "0" };
      // Out of sight it arrives where its row is, rather than sliding in from wherever it last was.
      const from = Number(at.opacity) < 0.01 ? { ...to, opacity: "0" } : at;
      Object.assign(element.style, to);
      if (Object.entries(to).every(([key, value]) => from[key as keyof typeof from] === value)) {
        return;
      }
      glide?.cancel();
      glide = reducedMotion()
        ? null
        : element.animate([from, to], { duration: durations.considered, easing: easings.settle });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => {
      observer.disconnect();
      glide?.cancel();
    };
  }, [list, target]);
  return (
    <span
      ref={spot}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 -z-10 rounded-card bg-surface opacity-0"
    />
  );
}

/** A pointer resting this long on a pick opens its card; moving between picks while it's open is instant. */
const OPEN_AFTER_MS = 260;
const CLOSE_AFTER_MS = 140;
/** As long as the card's fade out runs. */
const FADE_MS = 160;

/**
 * Which pick's card is open on a pointer device. It opens on a pointer that
 * moved onto a pick and rests there, or on focus, follows the pointer between picks, survives the trip
 * from a row onto the card itself, and closes once both are left.
 */
function usePickHover() {
  const enabled = useMediaQuery("(hover: hover) and (pointer: fine)");
  const [list, setList] = useState<HTMLUListElement | null>(null);
  const [state, setState] = useState<{ leg: Leg; anchor: Anchor } | null>(null);
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);
  // The pick a resting pointer is about to open, so moving on within its row doesn't start again.
  const pending = useRef<Leg | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };
  const close = useCallback(() => {
    clear();
    setClosing(true);
    timer.current = window.setTimeout(() => {
      setState(null);
      setClosing(false);
    }, FADE_MS);
  }, []);

  const peek = (leg: Leg, row: HTMLElement, now: boolean, pointerX?: number) => {
    if (!enabled || !list) return;
    if (!now && (pending.current === leg || (state?.leg === leg && !closing))) return;
    clear();
    const open = () => {
      pending.current = null;
      setClosing(false);
      const rect = row.getBoundingClientRect();
      setState({
        leg,
        anchor: { row: rect, list: list.getBoundingClientRect(), x: pointerX ?? rect.left + 56 },
      });
    };
    if (now || (state && !closing)) open();
    else {
      pending.current = leg;
      timer.current = window.setTimeout(open, OPEN_AFTER_MS);
    }
  };
  const leave = () => {
    clear();
    timer.current = window.setTimeout(close, CLOSE_AFTER_MS);
  };

  // Anchored where the row was: a scroll or resize would leave it pointing at nothing.
  useEffect(() => {
    if (!state) return undefined;
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [close, state]);
  useEffect(() => clear, []);

  return {
    enabled,
    list,
    setList,
    leg: state?.leg ?? null,
    anchor: state?.anchor ?? null,
    closing,
    peek,
    leave,
    // Back onto the card mid-fade brings it back.
    stay: () => {
      clear();
      setClosing(false);
    },
  };
}
