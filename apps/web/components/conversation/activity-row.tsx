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
 * and how it went at the end. A step too long for the line unfolds in place when tapped;
 * a thought shows its first sentence whole, wrapping rather than cut short, and unfolds the rest.
 */
export function ActivityRow({
  detail,
  duration,
  icon,
  result,
  status,
  swap = false,
  text,
  whole,
}: {
  readonly detail?: string | null;
  /** How long a live step took once finished ("420ms", "1.2s"), shown quietly on the right. */
  readonly duration?: string | null;
  readonly icon: ReactNode;
  /**
   * What the step found, a few quiet words: "$412 in cash". Given on any step
   * that may find something, null until it has, so the words blur in when it does.
   */
  readonly result?: string | null;
  /** Where the step is, as a mark at the end of the line; a thought has none. */
  readonly status?: Status | null;
  /**
   * Hand the words over in place as they change, as a tool step's do when it finishes.
   * A thought only grows at its end, past what the line shows, so it stays put.
   */
  readonly swap?: boolean;
  readonly text: string;
  /** All of a thought, of which `text` is the start: the line is never cut, and opens to this. */
  readonly whole?: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const clipped = cut || (whole !== undefined && whole.trim() !== text);

  // `clipped` swaps the row's element, so the new text node is measured too.
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || open) return;
    // The step's own words end in an ellipsis inside their swap, so they count as cut short too.
    const lines = [element, ...element.querySelectorAll<HTMLElement>("[data-slot=text-swap]")];
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
      <span
        className={cn(
          "min-w-0 flex-1",
          open
            ? "break-words whitespace-pre-wrap"
            : whole !== undefined
              ? "text-pretty"
              : !swap && "truncate",
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
              <span className={tone}>{open && whole !== undefined ? whole : text}</span>
              {detail ? (
                <span className={active ? undefined : "auni-activity-detail"}> {detail}</span>
              ) : null}
            </span>
          </SpotlightShimmer>
        )}
      </span>
      {result === undefined && duration === undefined ? null : (
        <span
          className={cn(
            "flex max-w-[52%] min-w-0 flex-none items-center text-meta",
            result && duration && "gap-2",
          )}
        >
          {result !== undefined ? (
            <span className="flex min-w-0 text-muted-foreground/80">
              <TextSwap align="end" text={result ?? ""} />
            </span>
          ) : null}
          {duration !== undefined ? (
            <span className="flex-none text-faint">
              <TextSwap align="end" text={duration ?? ""} />
            </span>
          ) : null}
        </span>
      )}
      {status ? (
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
      className="auni-activity-row auni-activity-control"
      data-active={active || undefined}
      data-slot="conversation-activity-row"
      onClick={() => setOpen((was) => !was)}
      type="button"
    >
      {label}
    </button>
  );
}
