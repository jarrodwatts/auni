"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

import { durations, easings, reducedMotion } from "@/lib/motion";

/**
 * A box that eases to its content's new height instead of jumping, whenever
 * that changes. It clips only while it moves, so focus rings and popovers are
 * whole at rest. The className places the box; padding belongs inside it.
 * Nested, the inner box eases and the outer one follows it, so a card in a
 * list keeps easing its own edges and a change eases once.
 */
export function AutoHeight({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const outer = box.current;
    const inner = content.current;
    if (!outer || !inner) return undefined;
    // The height it last laid out at; null until it first has, which never animates.
    let height: number | null = null;
    let glide: Animation | null = null;
    const stop = () => {
      glide?.cancel();
      glide = null;
      outer.style.overflow = "";
    };
    const observer = new ResizeObserver(([entry]) => {
      const to = entry?.borderBoxSize[0]?.blockSize ?? inner.offsetHeight;
      // Mid-ease, it sets off again from where it is.
      const from =
        glide?.playState === "running" ? Number.parseFloat(getComputedStyle(outer).height) : height;
      height = to;
      stop();
      if (from === null || Math.abs(to - from) < 0.5 || reducedMotion() || easesItself(inner)) {
        return;
      }
      outer.style.overflow = "clip";
      const run = outer.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: durations.resize,
        easing: easings.settle,
      });
      glide = run;
      run.finished.then(
        () => glide === run && stop(),
        () => undefined,
      );
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  return (
    <div ref={box} className={className} data-slot="auto-height">
      <div ref={content}>{children}</div>
    </div>
  );
}

/**
 * Content already easing its own height, like a row folding open or a box
 * like this one inside it, is followed as it goes rather than eased again on top.
 */
function easesItself(content: Element): boolean {
  return content
    .getAnimations({ subtree: true })
    .some((animation) =>
      animation instanceof CSSTransition
        ? /height|grid-template-rows/u.test(animation.transitionProperty)
        : animation.effect instanceof KeyframeEffect &&
          animation.effect.getKeyframes().some((frame) => "height" in frame),
    );
}
