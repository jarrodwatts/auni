"use client";

import { setBootDraft } from "@/components/app/composer-boot-draft";
import { cn } from "@/lib/utils";

export type ComposerLoadingPhase = "loading" | "ready";

/**
 * A slim floating pill at rest: the go-ahead chip, the words, and send on
 * one line, 52px tall, growing only as the words wrap. White with a soft
 * shadow and a hairline ring, since it floats over the conversation.
 */
export const COMPOSER_SURFACE_CLASS_NAME =
  "relative flex flex-none flex-col rounded-[26px] bg-card p-1.5 shadow-[0_6px_20px_--alpha(var(--color-shade)/8%),0_0_0_1px_--alpha(var(--foreground)/7%)]";

/** Where the composer rests under a conversation; the talk above dissolves into it rather than being cut. */
export const COMPOSER_DOCK_CLASS_NAME =
  "relative flex-none px-3 pt-1 pb-[max(.75rem,env(safe-area-inset-bottom))] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-linear-to-t before:from-background before:to-background/0 sm:mx-auto sm:w-full sm:max-w-[780px] sm:px-0 sm:pb-0";

/** The draft's text box, the same in the live composer and its loading veil. */
export const COMPOSER_INPUT_CLASS_NAME =
  "min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-reading leading-6 text-foreground outline-none placeholder:text-faint";

/** Exact content geometry used by both the composer veil and navigation preview. */
export function ComposerLoadingLayout({
  capture = false,
  className,
  label = "Message Auni",
  placeholder = "Ask anything about your money…",
}: {
  readonly capture?: boolean;
  readonly className?: string;
  readonly label?: string;
  readonly placeholder?: string;
}) {
  return (
    <div
      aria-hidden={capture ? undefined : true}
      className={cn("flex items-center gap-1", className)}
    >
      <span aria-hidden className="auni-loading-sheen h-10 w-[104px] flex-none rounded-full" />
      {capture ? (
        <textarea
          rows={1}
          aria-label={label}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(event) => setBootDraft(event.target.value)}
          className={COMPOSER_INPUT_CLASS_NAME}
        />
      ) : (
        <span className="flex h-10 min-w-0 flex-1 items-center px-2.5">
          <span className="auni-loading-sheen h-3 w-[min(68%,220px)] rounded-full" />
        </span>
      )}
      <span aria-hidden className="flex size-10 flex-none items-center justify-center">
        <span className="size-9 rounded-full bg-foreground/[0.07]" />
      </span>
    </div>
  );
}

/** Noninteractive composer with the same box model as the live form. */
export function ComposerLoadingSurface() {
  return (
    <div className={COMPOSER_SURFACE_CLASS_NAME}>
      <ComposerLoadingLayout />
    </div>
  );
}
