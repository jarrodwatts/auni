"use client";

import "./turn-work.css";

import { ChevronDown } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Status } from "@/components/motion/status-mark";
import { cn } from "@/lib/utils";

import { stepsFold, stepsSummary } from "./turn-model";

/**
 * One of Auni's thoughts, whole, on a quiet rail beside the answer. While Auni is still thinking
 * the rail is Auni's blue and the words grow at its end; once the turn moves on it goes quiet,
 * and a long thought shows its first lines with the rest a tap away.
 */
export function ThoughtRail({ live, text }: { readonly live: boolean; readonly text: string }) {
  const id = useId();
  const words = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  const clamped = !live && !open;

  // Long is what doesn't fit its lines when clamped; measured while clamped, kept while open.
  useLayoutEffect(() => {
    const element = words.current;
    if (!element || !clamped) return undefined;
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamped, text]);

  return (
    <div className="auni-thought" data-live={live || undefined} data-slot="thought">
      <p
        className={cn("whitespace-pre-wrap text-pretty", clamped && "line-clamp-4")}
        dir="auto"
        id={id}
        ref={words}
      >
        {text.trim()}
      </p>
      {!live && (long || open) ? (
        <button
          aria-controls={id}
          aria-expanded={open}
          className="auni-thought-more focus-ring"
          onClick={() => setOpen((was) => !was)}
          type="button"
        >
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

/** One step in a run: what it did as words, its mark, and its row. */
export interface TurnStep {
  readonly key: string;
  readonly iconKey: string;
  readonly icon: ReactNode;
  readonly status: Status | null;
  /** What it did, in the owner's words, as its row says it. */
  readonly title: string;
  readonly node: ReactNode;
}

/** How many of a run's marks lead its folded line; the words say the rest. */
const MAX_MARKS = 4;

/**
 * A run of steps Auni took between its words. While they run, each is its own line with its
 * mark; once the run is over it folds to one line that says what was done ("Checked your money
 * and put your moves together"), led by the marks of the services it used, and opens to the
 * steps again on a tap. One that failed or never finished stays open, so the owner sees where
 * the work stopped. A run of one step is just that step.
 */
export function TurnSteps({
  over,
  steps,
}: {
  /** Something came after the run, or the turn ended. */
  readonly over: boolean;
  readonly steps: readonly TurnStep[];
}) {
  const bodyId = useId();
  const folds =
    steps.length > 1 && stepsFold({ statuses: steps.map(({ status }) => status), over });
  const [opened, setOpened] = useState(false);
  const open = !folds || opened;

  if (steps.length === 0) return null;
  const rows = steps.map((step) => (
    <div key={step.key} className="min-w-0">
      {step.node}
    </div>
  ));
  if (!folds) return <div className="auni-steps">{rows}</div>;

  const marks = [...new Map(steps.map((step) => [step.iconKey, step])).values()].slice(
    0,
    MAX_MARKS,
  );
  return (
    <div className="auni-steps">
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        className="auni-steps-line focus-ring"
        data-slot="steps-line"
        onClick={() => setOpened((was) => !was)}
        type="button"
      >
        <span aria-hidden className="auni-steps-marks">
          {marks.map((step) => (
            <span key={step.iconKey} className="auni-steps-mark">
              {step.icon}
            </span>
          ))}
        </span>
        {/* Wraps rather than cut off: on a phone the line is the only word of what was done. */}
        <span className="min-w-0 text-pretty">{stepsSummary(steps.map(({ title }) => title))}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 flex-none transition-transform duration-200 ease-settle motion-reduce:transition-none",
            open && "rotate-180",
          )}
          strokeWidth={1.6}
        />
      </button>
      <div className="auni-fold" data-folded={!open} id={bodyId} inert={!open}>
        <div className="min-w-0">
          <div className="auni-steps-rows">{rows}</div>
        </div>
      </div>
    </div>
  );
}
