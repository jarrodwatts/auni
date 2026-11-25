"use client";

import { X } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { useRef, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";

import { cn } from "@/lib/utils";

type Side = "bottom" | "left" | "right";

/** Past this far toward its edge, or flicked faster than this, a drag closes the sheet. */
const CLOSE_DISTANCE = 96;
const CLOSE_VELOCITY = 0.6;

const AXIS: Record<Side, { readonly axis: "X" | "Y"; readonly sign: 1 | -1 }> = {
  bottom: { axis: "Y", sign: 1 },
  left: { axis: "X", sign: -1 },
  right: { axis: "X", sign: 1 },
};

const SIDE_CLASS_NAME: Record<Side, string> = {
  bottom:
    "inset-x-0 bottom-0 max-h-[calc(100dvh-max(24px,env(safe-area-inset-top)))] rounded-t-sheet shadow-float data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
  left: "inset-y-0 left-0 w-[min(86vw,340px)] touch-pan-y rounded-r-sheet shadow-float data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
  right:
    "inset-y-0 right-0 w-[392px] max-w-[calc(100vw-48px)] touch-pan-y border-l border-border shadow-float data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
};

/**
 * A surface over the app from one edge: the phone's places menu from the
 * left, a place's money from the bottom on a phone or the right on a small
 * laptop. It arrives on the long settle whole surfaces use and leaves
 * quicker. Tap outside, Escape, or drag it back toward its edge to close.
 */
export function AuniSheet({
  open,
  onOpenChange,
  side,
  title,
  initialFocus,
  className,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly side: Side;
  /** Named for screen readers; the content shows its own name. */
  readonly title: string;
  /** What takes focus as it opens, when that is better than the sheet itself: a field to type in. */
  readonly initialFocus?: RefObject<HTMLElement | null> | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  // It opens from state, not from a trigger, so it keeps what had focus (the row or tile that
  // opened it) and hands focus back there as it closes: else a keyboard user loses their place.
  const opener = useRef<Element | null>(null);
  const { sheet, shade, ...drag } = useSheetDrag(side, () => onOpenChange(false));

  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Overlay
          ref={shade}
          className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-[260ms] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-[420ms] motion-reduce:animate-none"
        />
        <SheetPrimitive.Content
          ref={sheet}
          aria-describedby={undefined}
          // Focus lands on the sheet itself, unless its owner names a better place: not its
          // first link, and never a phone keyboard by accident.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            opener.current = document.activeElement;
            (initialFocus?.current ?? sheet.current)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const from = opener.current;
            if (!(from instanceof HTMLElement) || !from.isConnected || from === document.body)
              return;
            event.preventDefault();
            from.focus();
          }}
          {...(side === "bottom" ? {} : drag)}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-popover outline-none data-[state=closed]:animate-out data-[state=closed]:duration-[260ms] data-[state=closed]:ease-[var(--motion-settle)] data-[state=open]:animate-in data-[state=open]:duration-[420ms] data-[state=open]:ease-[var(--motion-drift)] motion-reduce:animate-none",
            SIDE_CLASS_NAME[side],
            className,
          )}
        >
          <SheetPrimitive.Title className="sr-only">{title}</SheetPrimitive.Title>
          {side === "bottom" ? (
            // The strip wears the sheet's own background, and fades out over what scrolls beneath.
            <div
              {...drag}
              aria-hidden
              className="absolute inset-x-0 top-0 z-10 flex h-7 cursor-grab touch-none justify-center [background:inherit] pt-2.5 [mask-image:linear-gradient(to_bottom,#000_55%,transparent)] active:cursor-grabbing"
            >
              <span className="h-[5px] w-9 rounded-full bg-foreground/[0.13]" />
            </div>
          ) : null}
          <SheetPrimitive.Close
            className={cn(
              "absolute z-10 flex size-8 items-center justify-center rounded-control text-faint transition-colors hover:bg-foreground/[0.05] hover:text-ink focus-ring",
              // A phone closes by tapping out or dragging; the button stays for keyboards and screen readers.
              side === "right"
                ? "top-5 right-4"
                : "sr-only top-3 right-3 focus-visible:not-sr-only",
            )}
          >
            <X aria-hidden className="size-[17px]" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
          {children}
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}

/**
 * Dragging the sheet toward its edge: it follows the finger and the shade
 * thins with it, then it either closes or springs back. A gesture that
 * starts across the axis is a scroll and is left alone; a drag that moved
 * never also counts as a tap on what it started over. It holds the sheet's and the shade's refs
 * itself, as it moves them.
 */
function useSheetDrag(side: Side, onClose: () => void) {
  const { axis, sign } = AXIS[side];
  const sheet = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; at: number; d: number; live: boolean } | null>(null);
  const dragged = useRef(false);

  const place = (d: number, animate: boolean) => {
    const node = sheet.current;
    if (!node) return;
    const size = axis === "X" ? node.offsetWidth : node.offsetHeight;
    const ease = animate ? "260ms var(--motion-settle)" : "0ms";
    node.style.transition = `transform ${ease}`;
    node.style.transform = d > 0 ? `translate${axis}(${sign * d}px)` : "";
    if (shade.current) {
      shade.current.style.transition = `opacity ${ease}`;
      shade.current.style.opacity = d > 0 ? String(Math.max(0, 1 - d / size)) : "";
    }
  };

  return {
    sheet,
    shade,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      // The edge panels follow a finger; a mouse is there to click, select, and scroll.
      if (event.button !== 0 || (side !== "bottom" && event.pointerType === "mouse")) return;
      drag.current = { x: event.clientX, y: event.clientY, at: event.timeStamp, d: 0, live: false };
      dragged.current = false;
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (!current) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      const along = (axis === "X" ? dx : dy) * sign;
      const across = axis === "X" ? dy : dx;
      if (!current.live) {
        if (Math.abs(along) < 6 && Math.abs(across) < 6) return;
        if (Math.abs(across) > Math.abs(along)) {
          drag.current = null;
          return;
        }
        current.live = true;
        dragged.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      current.d = Math.max(0, along);
      place(current.d, false);
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      drag.current = null;
      if (!current?.live) return;
      const velocity = current.d / Math.max(1, event.timeStamp - current.at);
      if (current.d > CLOSE_DISTANCE || (current.d > 24 && velocity > CLOSE_VELOCITY)) onClose();
      else place(0, true);
    },
    onPointerCancel: () => {
      drag.current = null;
      place(0, true);
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (!dragged.current) return;
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
