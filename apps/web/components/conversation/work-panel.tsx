"use client";

import "./work-panel.css";

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { AutoHeight } from "@/components/motion/auto-height";
import { RollingNumber } from "@/components/motion/rolling-number";
import { SpotlightShimmer } from "@/components/motion/spotlight-shimmer";
import type { Status } from "@/components/motion/status-mark";
import { swapOf, swapTo } from "@/components/motion/swap";
import { TextSwap } from "@/components/motion/text-swap";
import { useHandover, type Motion } from "@/components/motion/use-handover";
import { blurs, durations, easings, reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { observeVisibleAnimation } from "@/lib/visible-animation";

import { LiveElapsed } from "./live-elapsed";
import { formatSettledDuration, parseStartMs } from "./work-clock";
import {
  AUTO_COLLAPSE_DELAY_MS,
  initialAutoCollapsed,
  shouldAutoCollapse,
  uniqueStepIcons,
  workPanelHeaderLabel,
} from "./work-panel-model";

const LABEL_LEAVE: Motion = {
  keyframes: [{ opacity: 0, filter: `blur(${blurs.soft}px)` }],
  options: { duration: durations.fast, easing: easings.settle },
};

const LABEL_ARRIVE: Motion = {
  keyframes: [
    { opacity: 0, filter: `blur(${blurs.soft}px)` },
    { opacity: 1, filter: "blur(0px)" },
  ],
  options: { duration: durations.standard, easing: easings.drift },
};

/** One step shown inside a work panel. */
export interface WorkPanelStep {
  readonly key: string;
  readonly iconKey: string;
  readonly icon: ReactNode;
  readonly isTool: boolean;
  readonly status: Status | null;
  readonly node: ReactNode;
}

/**
 * A living, morphing work enclosure: blooms wide as steps arrive, rolls step
 * counts and elapsed seconds like a precision counter, glides an active-row
 * highlight down the list as each tool runs, holds a brief beat on completion,
 * and morphs smoothly in both height and width into a compact summary pill.
 */
export function WorkPanel({
  active,
  canCollapse,
  liveLabel,
  liveOnMount,
  primary = false,
  settledDuration,
  steps,
  workStartedAt,
}: {
  /** True while this panel's work is still running. */
  readonly active: boolean;
  /** True once following text has arrived or the turn has settled. */
  readonly canCollapse: boolean;
  /** What the live turn is doing right now, shown between steps or when collapsed mid-work. */
  readonly liveLabel?: string | null | undefined;
  /** Whether this panel mounted during a live turn; history mounts settled and static. */
  readonly liveOnMount: boolean;
  /** Marks the primary trigger so the first-run landing dive can target it. */
  readonly primary?: boolean;
  /** Finalized duration shown once settled ("3.0s"), or null. */
  readonly settledDuration: string | null;
  readonly steps: readonly WorkPanelStep[];
  /** Turn start timestamp for the live rolling elapsed timer. */
  readonly workStartedAt?: string | undefined;
}) {
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const hasSteps = steps.length > 0;
  const anyRunning = steps.some((step) => step.status === "now");
  const failedCount = steps.filter((step) => step.status === "failed").length;
  // Running, failed, or interrupted (status: null) tool steps stay visible.
  const anyIncomplete = steps.some((step) => step.isTool && step.status !== "done");
  const toolCount = steps.filter((step) => step.isTool).length;
  const thoughtCount = steps.length - toolCount;
  const activeStepKey = steps.findLast((step) => step.status === "now")?.key ?? null;

  const [wasLiveOnMount] = useState(liveOnMount);
  const [panelMountedAtIso] = useState(() => new Date().toISOString());
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [autoCollapsed, setAutoCollapsed] = useState(() =>
    initialAutoCollapsed({
      liveOnMount,
      hasSteps,
      anyIncomplete,
      canCollapse,
    }),
  );

  // The primary panel continues the turn's live clock seamlessly from Thinking;
  // later inline panels count their own work from the moment they appear.
  const clockStartedAt = primary ? workStartedAt : panelMountedAtIso;

  // Capture each live panel's elapsed time when its work finishes so every
  // collapsed summary pill carries its own timing, even in multi-panel turns.
  const activeStartMsRef = useRef<number | null>(null);
  const [measuredDurationMs, setMeasuredDurationMs] = useState<number | null>(null);
  useEffect(() => {
    if (active) {
      if (activeStartMsRef.current === null) {
        activeStartMsRef.current = parseStartMs(clockStartedAt, Date.now());
      }
      return undefined;
    }
    if (activeStartMsRef.current === null) return undefined;
    const elapsed = Math.max(0, Date.now() - activeStartMsRef.current);
    activeStartMsRef.current = null;
    const frame = window.requestAnimationFrame(() => setMeasuredDurationMs(elapsed));
    return () => window.cancelAnimationFrame(frame);
  }, [active, clockStartedAt]);

  const wantCollapse = shouldAutoCollapse({
    hasSteps,
    anyIncomplete,
    canCollapse,
  });

  // If a new step joins a live panel after it folded, unfold it again.
  if (!wantCollapse && wasLiveOnMount && autoCollapsed) {
    setAutoCollapsed(false);
  }

  useEffect(() => {
    if (manualOpen !== null || !wantCollapse || autoCollapsed) return undefined;
    const delay = reducedMotion() ? 0 : AUTO_COLLAPSE_DELAY_MS;
    const timer = window.setTimeout(() => setAutoCollapsed(true), delay);
    return () => window.clearTimeout(timer);
  }, [autoCollapsed, manualOpen, wantCollapse]);

  const open = hasSteps && (manualOpen ?? !autoCollapsed);

  // Dynamic-Island width & radius morph between full-width card and compact summary pill.
  const prevOpenRef = useRef(open);
  const prevWidthRef = useRef<number | null>(null);
  const prevInnerWidthRef = useRef<number | null>(null);
  const widthAnimRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const observer = new ResizeObserver(() => {
      if (widthAnimRef.current === null) {
        prevWidthRef.current = panel.getBoundingClientRect().width;
        prevInnerWidthRef.current = panel.clientWidth;
      }
    });
    observer.observe(panel);
    prevWidthRef.current = panel.getBoundingClientRect().width;
    prevInnerWidthRef.current = panel.clientWidth;
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    const inFlight = widthAnimRef.current !== null;
    const fromWidth = inFlight ? panel.getBoundingClientRect().width : prevWidthRef.current;
    const fromInnerWidth = prevInnerWidthRef.current;
    widthAnimRef.current?.cancel();
    widthAnimRef.current = null;
    panel.style.removeProperty("--work-body-width");
    const toWidth = panel.getBoundingClientRect().width;
    const toInnerWidth = panel.clientWidth;

    if (
      wasOpen !== open &&
      fromWidth !== null &&
      Math.abs(toWidth - fromWidth) >= 2 &&
      !reducedMotion() &&
      typeof panel.animate === "function"
    ) {
      // Pin the inner step list to the expanded width while the outer enclosure
      // glides so rows never squish or reflow mid-morph.
      const expandedInner = open ? toInnerWidth : (fromInnerWidth ?? toInnerWidth);
      if (open) prevInnerWidthRef.current = toInnerWidth;
      if (expandedInner > 0) {
        panel.style.setProperty("--work-body-width", `${expandedInner}px`);
      }
      const fromRadius = wasOpen ? "15px" : "20px";
      const toRadius = open ? "15px" : "20px";
      const anim = panel.animate(
        [
          { width: `${fromWidth}px`, borderRadius: fromRadius },
          { width: `${toWidth}px`, borderRadius: toRadius },
        ],
        { duration: 340, easing: easings.settle },
      );
      widthAnimRef.current = anim;
      void anim.finished
        .catch(() => undefined)
        .then(() => {
          if (widthAnimRef.current === anim) {
            widthAnimRef.current = null;
            panel.style.removeProperty("--work-body-width");
            prevWidthRef.current = panel.getBoundingClientRect().width;
            prevInnerWidthRef.current = panel.clientWidth;
          }
        });
    } else {
      prevWidthRef.current = toWidth;
      prevInnerWidthRef.current = toInnerWidth;
    }
  }, [open]);

  // Gliding active-row highlight pill inside the step list.
  const pillVisibleRef = useRef(false);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    if (!pill) return undefined;
    const activeRow = open && activeStepKey ? (rowRefs.current.get(activeStepKey) ?? null) : null;
    if (!activeRow) {
      pillVisibleRef.current = false;
      pill.dataset.shown = "false";
      return undefined;
    }
    const place = (instant: boolean) => {
      if (instant) pill.dataset.instant = "true";
      else delete pill.dataset.instant;
      pill.style.transform = `translate3d(0, ${activeRow.offsetTop}px, 0)`;
      pill.style.height = `${activeRow.offsetHeight}px`;
      if (instant) {
        // Commit starting geometry before enabling glide transitions for future steps.
        void pill.offsetHeight;
        delete pill.dataset.instant;
      }
      pill.dataset.shown = "true";
    };
    place(!pillVisibleRef.current || reducedMotion());
    pillVisibleRef.current = true;

    const observer = new ResizeObserver(() => place(false));
    observer.observe(activeRow);
    return () => observer.disconnect();
  }, [activeStepKey, open, steps.length]);

  const icons = uniqueStepIcons(steps);
  const label = workPanelHeaderLabel({
    active,
    anyRunning,
    liveLabel,
    open,
    thoughtCount,
    toolCount,
  });
  const countingTools = active && open && anyRunning && toolCount > 0;
  // Prefer core's canonical turn duration for settled single-panel turns so live
  // and reopened history agree; fall back to each panel's own timing otherwise.
  const finalDuration = settledDuration ?? formatSettledDuration(measuredDurationMs);

  return (
    <div
      className={cn("auni-work-panel", wasLiveOnMount && "auni-work-panel-enter")}
      data-active={active || undefined}
      data-open={open}
      data-slot="work-panel"
      ref={panelRef}
    >
      {/* Whisper-subtle top-edge living sheen while steps are actively executing. */}
      {active ? (
        <span aria-hidden className="auni-work-sheen" ref={observeVisibleAnimation} />
      ) : null}

      <button
        aria-controls={hasSteps ? bodyId : undefined}
        aria-expanded={hasSteps ? open : undefined}
        className="auni-work-header"
        data-slot={primary ? "work-history-trigger" : "work-panel-trigger"}
        disabled={!hasSteps}
        onClick={hasSteps ? () => setManualOpen(!open) : undefined}
        type="button"
      >
        {icons.length > 0 ? (
          <span aria-hidden className="auni-work-icons">
            {icons.map((step, iconIndex) => (
              <span
                key={step.iconKey}
                className={cn("auni-work-icon", wasLiveOnMount && "auni-work-icon-enter")}
                style={{ zIndex: iconIndex + 1 }}
              >
                {step.icon}
              </span>
            ))}
          </span>
        ) : null}

        {/* Only what it is doing is announced; the clock ticks for the eye alone. */}
        <span aria-live={active ? "polite" : undefined} className="min-w-0 flex-auto">
          <SpotlightShimmer active={active} className="text-muted-foreground">
            <WorkHeaderLabel counting={countingTools} label={label} toolCount={toolCount} />
          </SpotlightShimmer>
        </span>

        {failedCount > 0 ? (
          <span className="auni-work-failed-badge">
            <TextSwap align="end" text={`${failedCount} failed`} />
          </span>
        ) : null}

        {active ? (
          <LiveElapsed
            className="flex-none text-meta text-muted-foreground/75"
            startedAt={clockStartedAt}
          />
        ) : finalDuration !== null ? (
          <span aria-hidden className="flex-none text-meta text-muted-foreground/75 tabular-nums">
            <TextSwap align="end" text={finalDuration} />
          </span>
        ) : null}

        {hasSteps ? (
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 flex-none text-muted-foreground/75 transition-transform duration-240 ease-settle motion-reduce:transition-none",
              open && "rotate-180",
            )}
            strokeWidth={1.6}
          />
        ) : null}
      </button>

      <div
        className="auni-work-body"
        data-open={open}
        id={bodyId}
        inert={!open}
        onFocusCapture={() => {
          if (open && manualOpen === null) setManualOpen(true);
        }}
        onPointerDownCapture={() => {
          if (open && manualOpen === null) setManualOpen(true);
        }}
      >
        <div className="auni-work-body-inner">
          <div className="auni-work-divider" />
          <AutoHeight duration={280}>
            <div className="auni-work-list" ref={listRef}>
              <div aria-hidden className="auni-work-active-pill" data-shown="false" ref={pillRef} />
              {steps.map((step) => (
                <div
                  key={step.key}
                  className={cn("relative z-1 min-w-0", wasLiveOnMount && "auni-work-row-enter")}
                  ref={(node) => {
                    if (node) rowRefs.current.set(step.key, node);
                    else rowRefs.current.delete(step.key);
                  }}
                >
                  {step.node}
                </div>
              ))}
            </div>
          </AutoHeight>
        </div>
      </div>
    </div>
  );
}

interface HeaderLabelValue {
  readonly modeKey: string;
  readonly counting: boolean;
  readonly label: string;
  readonly toolCount: number;
}

/**
 * Rolls only the numeric step digit when counting up ("Working on 1 -> 2 -> 3 steps"),
 * and performs a full optical blur-morph when changing status ("Working on 6 steps" -> "Thinking" -> "6 steps").
 */
function WorkHeaderLabel({
  counting,
  label,
  toolCount,
}: {
  readonly counting: boolean;
  readonly label: string;
  readonly toolCount: number;
}) {
  const modeKey = counting ? "counting" : `label:${label}`;
  const [swap, setSwap] = useState<ReturnType<typeof swapOf<HeaderLabelValue>>>(() =>
    swapOf({ modeKey, counting, label, toolCount }),
  );
  if (
    swap.current.modeKey !== modeKey ||
    swap.current.toolCount !== toolCount ||
    swap.current.label !== label
  ) {
    const modeChanged = swap.current.modeKey !== modeKey;
    setSwap(swapTo(swap, { modeKey, counting, label, toolCount }, modeChanged && !reducedMotion()));
  }
  const copy = useHandover(swap, setSwap, LABEL_LEAVE, LABEL_ARRIVE);
  const copies = [...swap.leaving, { id: swap.id, value: swap.current }];

  return (
    <span className="relative inline-block max-w-full align-bottom whitespace-nowrap">
      {copies.map(({ id, value }) => {
        const isCurrent = id === swap.id;
        return (
          <span
            aria-hidden={!isCurrent || undefined}
            className={cn(
              "inline-flex max-w-full items-center truncate",
              !isCurrent && "pointer-events-none absolute top-0 left-0",
            )}
            key={id}
            ref={copy(id)}
          >
            {value.counting ? (
              <>
                <span className="whitespace-pre">Working on </span>
                <RollingNumber value={value.toolCount} />
                <span className="whitespace-pre">{value.toolCount === 1 ? " step" : " steps"}</span>
              </>
            ) : (
              value.label
            )}
          </span>
        );
      })}
    </span>
  );
}
