"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { blurs, durations, easings, reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

import { swapOf, swapTo } from "./swap";
import { useHandover, type Motion } from "./use-handover";

const LEAVE: Motion = {
  keyframes: [{ opacity: 0, transform: "translateY(-0.24em)", filter: `blur(${blurs.subtle}px)` }],
  options: { duration: durations.fast, easing: easings.settle },
};

const ARRIVE: Motion = {
  keyframes: [
    { opacity: 0, transform: "translateY(0.3em)", filter: `blur(${blurs.soft}px)` },
    { opacity: 1, transform: "none", filter: "blur(0px)" },
  ],
  options: { duration: durations.standard, easing: easings.drift },
};

/**
 * One line of words that hands over when they change: the old words lift
 * away as the new ones rise in, and the line eases to its new width, so
 * nothing beside it jumps. Too long for its room, the words end in an
 * ellipsis, or with `wrap` run onto a second line first. Only the current
 * words are read out.
 */
export function TextSwap({
  className,
  text,
  wrap = false,
}: {
  /** Styles the current words, and stays with them as they leave: `shimmer` while working. */
  readonly className?: string;
  readonly text: string;
  /** Words that must be read whole, such as what a card buys, take two lines before an ellipsis. */
  readonly wrap?: boolean;
}) {
  const [swap, setSwap] = useState(() => swapOf({ className, text }));
  if (swap.current.text !== text || swap.current.className !== className) {
    setSwap(swapTo(swap, { className, text }, swap.current.text !== text && !reducedMotion()));
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
            {value.text}
          </span>
        ) : (
          <span
            key={id}
            ref={copy(id)}
            aria-hidden
            className={cn("pointer-events-none absolute top-0 left-0", fit, value.className)}
          >
            {value.text}
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
