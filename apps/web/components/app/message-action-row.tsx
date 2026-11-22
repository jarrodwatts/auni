"use client";

import { Check, Copy } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

const messageRowActionClassName =
  "size-11 rounded-full text-muted-foreground/70 transition-[color,background-color,transform] hover:bg-muted/70 hover:text-foreground active:scale-95 sm:size-8";

/**
 * A message's time and actions stay out of the timeline until they're wanted:
 * they fade in on hover, when focus reaches them, or on a long press on touch
 * screens. Focus elsewhere in the message, like typing into a card, leaves them be.
 */
export function MessageActionsRow({
  align,
  children,
}: {
  readonly align: "start" | "end";
  readonly children: React.ReactNode;
}) {
  return (
    <div
      data-slot="message-actions"
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity duration-200 ease-settle focus-within:opacity-100 group-data-revealed/message:opacity-100 motion-reduce:transition-none pointer-fine:group-hover/message:opacity-100",
        // A phone keeps its own words clean, the way a chat app does, until a long press.
        align === "end" && "justify-end max-sm:hidden max-sm:group-data-revealed/message:flex",
      )}
    >
      {children}
    </div>
  );
}

export function MessageTimestamp({
  createdAt,
  className,
}: {
  readonly createdAt: string;
  readonly className?: string;
}) {
  const sent = new Date(createdAt);
  if (Number.isNaN(sent.getTime())) return null;

  return (
    // The server renders in its own time zone; only the browser knows the
    // person's. The mismatch is expected, so hydration must not warn about it.
    <time
      className={cn("text-xs tabular-nums text-muted-foreground/70", className)}
      dateTime={createdAt}
      suppressHydrationWarning
    >
      {sent.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}

const LONG_PRESS_MS = 450;

/**
 * A long press on a message reveals its actions row on touch screens, where
 * it otherwise stays out of the way. Spread the result onto the message.
 */
export function useLongPressReveal() {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<number | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const node = useRef<HTMLDivElement | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // A tap anywhere else puts it away again.
  useEffect(() => {
    if (!revealed) return;
    const away = (event: PointerEvent) => {
      if (!node.current?.contains(event.target as Node)) setRevealed(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [revealed]);
  useEffect(() => cancel, [cancel]);

  return {
    ref: node,
    "data-revealed": revealed || undefined,
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType !== "touch") return;
      cancel();
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => setRevealed(true), LONG_PRESS_MS);
    },
    // A scroll is not a press.
    onPointerMove: (event: ReactPointerEvent) => {
      const { x, y } = start.current;
      if (Math.hypot(event.clientX - x, event.clientY - y) > 8) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
}

export function CopyMessageAction({ text }: { readonly text: string }) {
  const { blocked, copiedValue, copy } = useClipboardCopy();
  const copied = copiedValue === text;
  return (
    <MessageRowAction
      label={copied ? "Copied" : blocked ? "This browser won't copy" : "Copy message"}
      onClick={() => copy(text)}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </MessageRowAction>
  );
}

export function MessageRowAction({
  children,
  label,
  onClick,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={label}
            className={messageRowActionClassName}
            onClick={onClick}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
