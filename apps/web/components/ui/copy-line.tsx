"use client";

import { Check, Copy } from "lucide-react";

import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

/**
 * Something the owner copies: a command they run themselves in their terminal (`command`, shown
 * after a `$`), or an address, under its `label`. The whole of it always shows, wrapping where
 * it must, since the owner reads what they're told to run or send to; Copy keeps its own column.
 * Auni never runs a command for them: a login, or a fresh pairing link, is theirs to make.
 */
export function CopyLine({
  value,
  label,
  command = false,
  className,
  focused = false,
}: {
  readonly value: string;
  readonly label?: string;
  readonly command?: boolean;
  readonly className?: string;
  /** Takes focus as it appears, when copying it is the one thing to do next. */
  readonly focused?: boolean;
}) {
  const clipboard = useClipboardCopy();
  const copied = clipboard.copiedValue === value;
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center gap-2 rounded-control bg-surface py-1.5 pr-1.5 pl-3.5 text-left">
        <span className="min-w-0 flex-1 py-1">
          {label ? (
            <span className="block text-caption font-medium text-muted-foreground">{label}</span>
          ) : null}
          <span className="flex gap-2 font-mono text-meta leading-[20px]">
            {command ? (
              <span aria-hidden className="text-faint select-none">
                $
              </span>
            ) : null}
            <code className="min-w-0 flex-1 whitespace-pre-wrap text-ink wrap-anywhere select-all">
              {value}
            </code>
          </span>
        </span>
        <button
          type="button"
          autoFocus={focused}
          onClick={() => clipboard.copy(value)}
          aria-label={copied ? "Copied" : `Copy ${label ?? value}`}
          className="flex h-8 flex-none items-center gap-1.5 self-center rounded-control px-2.5 text-meta font-medium text-muted-foreground transition-colors hover:bg-card hover:text-ink focus-ring"
        >
          {copied ? (
            <Check aria-hidden className="size-3.5 text-ink" />
          ) : (
            <Copy aria-hidden className="size-3.5" />
          )}
          <span aria-hidden>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {clipboard.blocked ? (
        <p role="alert" className="mt-1.5 text-meta text-muted-foreground">
          Copying was blocked. Select it to copy it.
        </p>
      ) : null}
    </div>
  );
}
