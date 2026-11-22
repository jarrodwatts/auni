"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
  icon,
  result,
  status,
  swap = false,
  text,
  whole,
}: {
  readonly detail?: string | null;
  readonly icon: ReactNode;
  /**
   * What the step found, a few quiet words: "$412 in cash". Given on any step
   * that may find something, null until it has, so the words rise in when it does.
   */
  readonly result?: string | null;
  /** Where the step is, as a mark at the end of the line; a thought has none. */
  readonly status?: Status | null;
  /**
   * Hand the words over as they change, as a tool step's do when it finishes.
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

  // Under way, the words shimmer; done, they read in full ink.
  const tone =
    status === "now" ? "shimmer shimmer-duration-1500" : status === "done" ? "text-ink" : undefined;
  const label = (
    <>
      <span aria-hidden className="auni-activity-icon">
        {icon}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          open
            ? "break-words whitespace-pre-wrap"
            : whole !== undefined
              ? "text-pretty"
              : "truncate",
        )}
        ref={textRef}
      >
        {swap && !open ? (
          <TextSwap className={tone} text={text} />
        ) : (
          <span className={tone}>{open && whole !== undefined ? whole : text}</span>
        )}
        {detail ? <span className="auni-activity-detail"> {detail}</span> : null}
      </span>
      {result === undefined ? null : (
        <span className="max-w-[45%] flex-none text-[13px] text-faint tabular-nums">
          <TextSwap text={result ?? ""} />
        </span>
      )}
      {status ? (
        <span className="flex h-5 flex-none items-center">
          <StatusMark size={14} status={status} />
        </span>
      ) : null}
    </>
  );

  if (!clipped && !open)
    return (
      <div className="auni-activity-row" data-slot="conversation-activity-row">
        {label}
      </div>
    );

  return (
    <button
      aria-expanded={open}
      className="auni-activity-row auni-activity-control"
      data-slot="conversation-activity-row"
      onClick={() => setOpen(!open)}
      type="button"
    >
      {label}
    </button>
  );
}
