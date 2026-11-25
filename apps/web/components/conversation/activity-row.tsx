"use client";

import "./activity-row.css";

import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { SpotlightShimmer } from "@/components/motion/spotlight-shimmer";
import { StatusMark, type Status } from "@/components/motion/status-mark";
import { TextSwap } from "@/components/motion/text-swap";
import { cn } from "@/lib/utils";

/**
 * One step of the work on one line: what it did, what it found on the right,
 * and how it went at the end (on a phone, what it found sits under it). A step too long for
 * its room unfolds in place when tapped.
 */
export function ActivityRow({
  detail,
  icon,
  result,
  status,
  swap = false,
  text,
}: {
  readonly detail?: string | null;
  readonly icon: ReactNode;
  /**
   * What the step found, a few quiet words: "$412 in cash". Given on any step
   * that may find something, null until it has, so the words blur in when it does.
   */
  readonly result?: string | null;
  /** Where the step is, as a mark at the end of the line. */
  readonly status?: Status | null;
  /** Hand the words over in place as they change, as a step's do when it finishes. */
  readonly swap?: boolean;
  readonly text: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const clipped = cut;

  // `clipped` swaps the row's element, so the new text node is measured too.
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || open) return;
    // The step's words, and what it found, end in an ellipsis inside their swaps, so they count
    // as cut short too.
    const swaps = (element.parentElement ?? element).querySelectorAll<HTMLElement>(
      "[data-slot=text-swap]",
    );
    const lines = [element, ...swaps];
    const observer = new ResizeObserver(() =>
      setCut(lines.some((line) => line.scrollWidth > line.clientWidth)),
    );
    for (const line of lines) observer.observe(line);
    return () => observer.disconnect();
  }, [clipped, detail, open, text]);

  // Under way, a soft spotlight glides across the line; done, it sharpens to full ink.
  const active = status === "now";
  const tone = status === "done" ? "text-ink" : undefined;
  const label = (
    <>
      <span
        aria-hidden
        className={cn(
          "auni-activity-icon transition-colors duration-200 ease-settle motion-reduce:transition-none",
          status === "done" && "text-ink-soft",
          status === "failed" && "text-negative",
        )}
      >
        {icon}
      </span>
      {/* On a phone what it found takes a line of its own under the step, so neither cuts the other. */}
      <span className="flex min-w-0 flex-[1_1_auto] flex-col sm:flex-row sm:items-start sm:gap-2">
        <span
          className={cn(
            "min-w-0 sm:flex-[1_1_auto]",
            open ? "break-words whitespace-pre-wrap" : !swap && "truncate",
          )}
          ref={textRef}
        >
          {swap && !open ? (
            <SpotlightShimmer active={active} className="max-w-full">
              <TextSwap
                className={tone}
                detail={detail}
                detailClassName={active ? undefined : "auni-activity-detail"}
                text={text}
              />
            </SpotlightShimmer>
          ) : (
            <SpotlightShimmer active={active} className="max-w-full">
              <span className="min-w-0 break-words">
                <span className={tone}>{text}</span>
                {detail ? (
                  <span className={active ? undefined : "auni-activity-detail"}> {detail}</span>
                ) : null}
              </span>
            </SpotlightShimmer>
          )}
        </span>
        {result === undefined ? null : (
          // Beside the step on a wider screen, it gives way before what the step did; open, it reads whole.
          <span className="flex min-w-0 items-center text-meta text-muted-foreground/80 tabular-nums sm:max-w-[52%] sm:flex-[0_100_auto] sm:justify-end">
            {open ? (
              <span className="min-w-0 break-words">{result}</span>
            ) : (
              <TextSwap align="end" text={result ?? ""} />
            )}
          </span>
        )}
      </span>
      {/* A finished step's words already say it's done; only one under way or failed is marked. */}
      {status && status !== "done" ? (
        <span className="flex h-5 flex-none items-center">
          <StatusMark size={14} status={status} variant="bare" />
        </span>
      ) : null}
      {clipped || open ? (
        <span aria-hidden className="flex h-5 flex-none items-center text-faint">
          <ChevronDown
            className={cn(
              "size-3.5 transition-transform duration-200 ease-settle motion-reduce:transition-none",
              open && "rotate-180",
            )}
            strokeWidth={1.6}
          />
        </span>
      ) : null}
    </>
  );

  if (!clipped && !open)
    return (
      <div
        className="auni-activity-row"
        data-active={active || undefined}
        data-slot="conversation-activity-row"
      >
        {label}
      </div>
    );

  return (
    <button
      aria-expanded={open}
      className="auni-activity-row auni-activity-control focus-ring"
      data-active={active || undefined}
      data-slot="conversation-activity-row"
      onClick={() => setOpen((was) => !was)}
      type="button"
    >
      {label}
    </button>
  );
}
