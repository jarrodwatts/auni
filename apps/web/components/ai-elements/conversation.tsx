"use client";

import { ArrowDownIcon } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import {
  StickToBottom,
  useStickToBottomContext,
  type GetTargetScrollTop,
} from "use-stick-to-bottom";

import { ProgressRing } from "@/components/motion/progress-ring";
import { REDUCED_MOTION, useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

/**
 * How much of what came before stays in view above a turn read from its start, in pixels: a
 * glimpse, so the rest of the window, on a phone too, goes to the new turn as it arrives.
 */
const KEPT_ABOVE = 24;
/** As close to the end, in pixels, as the library counts as there. */
const NEAR = 70;

/**
 * Where the follow stops. The end, unless a turn is marked to be read from its start
 * (`data-read-from-start`): then it follows that turn as it grows only until its beginning
 * reaches the top of the window, so a tall card that arrives whole is met at its heading and
 * not at its last line, and a card that arrives below words is brought up as far as the window
 * allows. Either way the owner's newest message (`data-owner-turn`) is in view whole or not at
 * all: an answer a little taller than the room under it would otherwise leave a sliver of their
 * words under the header, so the follow stops short with all of them in view until the answer
 * has grown past them.
 */
export const followTo: GetTargetScrollTop = (end, { contentElement }) => {
  const origin = contentElement.getBoundingClientRect().top;
  const span = (element: Element | null | undefined) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { start: box.top - origin, end: box.bottom - origin };
  };
  const turn = span(contentElement.querySelector("[data-read-from-start]"));
  const target = turn ? Math.min(end, turn.start - KEPT_ABOVE) : end;
  const own = span([...contentElement.querySelectorAll("[data-owner-turn]")].at(-1));
  return own && target > own.start - KEPT_ABOVE && target < own.end
    ? own.start - KEPT_ABOVE
    : target;
};

/**
 * A transcript that keeps the newest words in view, the way AI Elements' Conversation
 * does: it follows the answer as it grows, lets go the moment the reader scrolls up,
 * and takes them back to the end when they send or tap the jump control.
 */
export function Conversation({
  children,
  className,
  resize = "smooth",
  ...props
}: ComponentProps<typeof StickToBottom>) {
  const reduced = useMediaQuery(REDUCED_MOTION);
  return (
    <StickToBottom
      className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-hidden", className)}
      initial="instant"
      resize={reduced ? "instant" : resize}
      role="log"
      targetScrollTop={followTo}
      {...props}
    >
      {children}
    </StickToBottom>
  );
}

const TRANSCRIPT_CONTROLS = "button, a[href], summary, [role='button']";

export function ConversationContent({
  className,
  onReadOn,
  ...props
}: ComponentProps<typeof StickToBottom.Content> & {
  /** The reader scrolls on from a turn the follow stopped at the start of (see followTo). */
  readonly onReadOn?: () => void;
}) {
  const { state, stopScroll } = useStickToBottomContext();
  // Pressing a control in the transcript is the reader taking over: whatever it opens
  // stays in view instead of being followed past. Sending or the jump control resumes.
  const takeOver = (event: { readonly target: EventTarget }) => {
    if (event.target instanceof Element && event.target.closest(TRANSCRIPT_CONTROLS)) stopScroll();
  };
  // So is scrolling on from a turn met at its start: the place is theirs from here, and the
  // jump control offers the rest. At the true end there is nothing to let go of.
  const readOn = () => {
    if (state.calculatedTargetScrollTop >= state.targetScrollTop) return;
    stopScroll();
    onReadOn?.();
  };
  return (
    <StickToBottom.Content
      onKeyDownCapture={takeOver}
      onPointerDownCapture={takeOver}
      onTouchMoveCapture={readOn}
      onWheelCapture={readOn}
      // The bottom inset is the column's: the jump control sits over the same corner of every transcript.
      className={cn("flex min-h-full flex-col gap-6 pb-14", className)}
      data-slot="conversation-content"
      // The library leaves both axes to scroll; a transcript only ever scrolls down, so a
      // card's edge poking past the column can't put a sideways bar under the words. Its foot
      // fades clear under the jump control while that shows (auni-transcript in globals.css).
      scrollClassName="auni-transcript min-h-0 min-w-0 overflow-x-hidden overflow-y-auto scrollbar-thin overscroll-contain"
      {...props}
    />
  );
}

/**
 * The library follows its content growing, and leaves two things. Its window shrinking from
 * below: the reply box growing a line or docking replies would otherwise cover whatever sat at
 * the window's foot, the last card's buttons among them. Followed to the end, the view goes
 * back to the end; held anywhere else (the owner tapped into a card, which lets go of the
 * follow), it moves up by what the window lost, so that foot stays in sight above the dock.
 * And its content shrinking above a turn met at its start (a card over it folding to its
 * receipt), which would slide that turn up and away: the view goes back to its start.
 */
export function ConversationViewportFollow() {
  const { contentRef, scrollRef, scrollToBottom, state } = useStickToBottomContext();

  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let height = viewport.clientHeight;
    const frame = new ResizeObserver(() => {
      const lost = height - viewport.clientHeight;
      height = viewport.clientHeight;
      if (lost <= 0) return;
      if (state.isAtBottom) void scrollToBottom("instant");
      else viewport.scrollTop += lost;
    });
    const words = new ResizeObserver(() => {
      const start = state.calculatedTargetScrollTop;
      if (state.isAtBottom && start < state.targetScrollTop && state.scrollTop > start)
        state.scrollTop = start;
    });
    frame.observe(viewport);
    words.observe(content);
    return () => {
      frame.disconnect();
      words.disconnect();
    };
  }, [contentRef, scrollRef, scrollToBottom, state]);

  return null;
}

/** Legs of money through, of all of them, while some are still on their way. */
interface MovingMoney {
  readonly done: number;
  readonly total: number;
}

/**
 * The jump back to the newest words. While the chat's money moves out of
 * view it says so: the round button glides wide into a pill with the money's
 * ring and words, and back once it has settled.
 */
export function ConversationScrollButton({
  className,
  moving = null,
  onReadOn,
  ...props
}: ComponentProps<"button"> & {
  readonly moving?: MovingMoney | null;
  /** The reader jumps on from a turn the follow stopped at the start of (see followTo). */
  readonly onReadOn?: () => void;
}) {
  const { contentRef, isAtBottom, scrollRef, scrollToBottom, state } = useStickToBottomContext();
  const reduced = useMediaQuery(REDUCED_MOTION);
  // The library takes a turn met at its start for the end, so the control looks for itself
  // whether more of that turn lies below the window.
  const [more, setMore] = useState(false);
  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const look = () =>
      setMore(
        state.targetScrollTop - Math.max(state.calculatedTargetScrollTop, state.scrollTop) > NEAR,
      );
    const observer = new ResizeObserver(look);
    observer.observe(content);
    viewport.addEventListener("scroll", look, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", look);
    };
  }, [contentRef, scrollRef, state]);
  const atEnd = isAtBottom && !more;
  // The last count stays drawn while the pill narrows away.
  const [shown, setShown] = useState(moving);
  if (moving && (moving.done !== shown?.done || moving.total !== shown?.total)) setShown(moving);

  return (
    <button
      aria-hidden={atEnd || undefined}
      className={cn(
        "absolute inset-s-1/2 bottom-4 flex h-9 -translate-x-1/2 items-center rounded-full border border-foreground/[0.09] bg-popover text-muted-foreground shadow-[0_10px_26px_--alpha(var(--color-shade)/16%)] transition-[opacity,translate,scale] duration-200 ease-out hover:bg-surface hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-95 data-[at-bottom=true]:pointer-events-none data-[at-bottom=true]:translate-y-2 data-[at-bottom=true]:scale-95 data-[at-bottom=true]:opacity-0 rtl:translate-x-1/2",
        // Include the border when extending the 36px circle's hit area to 40px.
        "before:absolute before:-inset-[3px] before:rounded-full",
        className,
      )}
      data-at-bottom={atEnd}
      data-slot="conversation-scroll-button"
      onClick={() => {
        onReadOn?.();
        void scrollToBottom(reduced ? "instant" : undefined);
      }}
      tabIndex={atEnd ? -1 : undefined}
      type="button"
      {...props}
    >
      <span
        aria-hidden={!moving || undefined}
        className={cn(
          "grid transition-[grid-template-columns] duration-(--motion-duration-resize) ease-settle motion-reduce:transition-none",
          moving ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
        )}
      >
        <span className="min-w-0 overflow-hidden">
          {shown ? (
            <span className="flex items-center gap-2 ps-3 text-[13px] font-medium whitespace-nowrap text-ink">
              <ProgressRing done={shown.done} total={shown.total} status="now" size={18} />
              Moving your money
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex size-[34px] flex-none items-center justify-center">
        <ArrowDownIcon aria-hidden className="size-4" />
      </span>
      <span className="sr-only">Jump to latest</span>
    </button>
  );
}
