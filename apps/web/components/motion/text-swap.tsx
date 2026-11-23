"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { blurs, durations, easings, reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

import { swapOf, swapTo } from "./swap";
import { useHandover, type Motion } from "./use-handover";

const LEAVE: Motion = {
  keyframes: [{ opacity: 0, filter: `blur(${blurs.soft}px)` }],
  options: { duration: durations.fast, easing: easings.settle },
};

const ARRIVE: Motion = {
  keyframes: [
    { opacity: 0, filter: `blur(${blurs.soft}px)` },
    { opacity: 1, filter: "blur(0px)" },
  ],
  options: { duration: durations.standard, easing: easings.drift },
};

interface TextSwapCopy {
  readonly className?: string | undefined;
  readonly detail?: string | null | undefined;
  readonly detailClassName?: string | undefined;
  readonly text: string;
}

/**
 * One line of words that hands over in place when they change: the old words
 * soften out of focus as the new ones sharpen in on the same baseline, and the
 * line eases to its new width so nothing beside it jumps. Too long for its
 * room, the words end in an ellipsis, or with `wrap` run onto a second line
 * first. Only the current words are read out.
 */
export function TextSwap({
  align = "start",
  className,
  detail,
  detailClassName,
  text,
  wrap = false,
}: {
  /** Which edge a leaving copy anchors to while the width glides. */
  readonly align?: "start" | "end";
  /** Styles the current words, and stays with them as they leave. */
  readonly className?: string | undefined;
  /** Optional quieter phrase kept inside the same blur-morph. */
  readonly detail?: string | null | undefined;
  readonly detailClassName?: string | undefined;
  readonly text: string;
  /** Words that must be read whole, such as what a card buys, take two lines before an ellipsis. */
  readonly wrap?: boolean;
}) {
  const [swap, setSwap] = useState<ReturnType<typeof swapOf<TextSwapCopy>>>(() =>
    swapOf({ className, detail, detailClassName, text }),
  );
  if (
    swap.current.text !== text ||
    swap.current.detail !== detail ||
    swap.current.className !== className ||
    swap.current.detailClassName !== detailClassName
  ) {
    const visibleChange = swap.current.text !== text || swap.current.detail !== detail;
    setSwap(
      swapTo(
        swap,
        { className, detail, detailClassName, text },
        visibleChange && !reducedMotion(),
      ),
    );
  }
  const copy = useHandover(swap, setSwap, LEAVE, ARRIVE);

  const box = useRef<HTMLSpanElement>(null);
  // The width the line last laid out at, still the old words' when new ones commit.
  const width = useRef<number | null>(null);
  const glide = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      width.current = entry?.borderBoxSize[0]?.inlineSize ?? null;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const line = box.current;
    const from = width.current;
    if (swap.id === 0 || !line || from === null) return;
    glide.current?.cancel();
    glide.current = glideWidth(line, from);
  }, [swap.id]);

  const copies = [...swap.leaving, { id: swap.id, value: swap.current }];
  const fit = wrap ? "line-clamp-2" : "truncate";
  const anchor = align === "end" ? "right-0" : "left-0";
  const renderCopy = (value: TextSwapCopy) => (
    <>
      {value.text}
      {value.detail ? <span className={value.detailClassName}> {value.detail}</span> : null}
    </>
  );
  return (
    <span
      ref={box}
      className={cn("relative inline-block max-w-full align-bottom", !wrap && "whitespace-nowrap")}
    >
      {copies.map(({ id, value }) =>
        id === swap.id ? (
          <span
            key={id}
            ref={copy(id)}
            className={cn(!wrap && "block", fit, value.className)}
            data-slot="text-swap"
          >
            {renderCopy(value)}
          </span>
        ) : (
          <span
            key={id}
            ref={copy(id)}
            aria-hidden
            className={cn("pointer-events-none absolute top-0", anchor, fit, value.className)}
          >
            {renderCopy(value)}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * Eases a line from the old words' width to the new. Leaving words keep the
 * width they had, so they end where they ended; the new words hold their full
 * width while the line eases out to it, so they never show cut short.
 */
function glideWidth(line: HTMLElement, from: number): Animation | null {
  const words = line.lastElementChild;
  if (!(words instanceof HTMLElement)) return null;
  for (const each of line.children) {
    if (each !== words && each instanceof HTMLElement && !each.style.width) {
      each.style.width = `${from}px`;
    }
  }
  const to = Number.parseFloat(getComputedStyle(line).width);
  if (Math.abs(to - from) < 0.5) return null;
  words.style.width = `${to}px`;
  const glide = line.animate([{ width: `${from}px` }, { width: `${to}px` }], {
    duration: durations.resize,
    easing: easings.settle,
  });
  glide.finished.then(
    () => words.style.removeProperty("width"),
    () => undefined,
  );
  return glide;
}
