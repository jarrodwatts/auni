"use client";

import { setBootDraft } from "@/components/app/composer-boot-draft";
import { cn } from "@/lib/utils";

export type ComposerLoadingPhase = "loading" | "ready";

/**
 * Floating rounded composer card with a quiet interior bar for model selection
 * and send, echoing T3 Code's layout in Auni's calm visual language.
 */
export const COMPOSER_SURFACE_CLASS_NAME =
  "relative flex flex-none flex-col rounded-[22px] bg-card px-3 pt-2.5 pb-2 shadow-[0_6px_20px_--alpha(var(--color-shade)/8%),0_0_0_1px_--alpha(var(--foreground)/7%)]";

/** Where the composer rests under a conversation; the talk above dissolves into it rather than being cut. */
export const COMPOSER_DOCK_CLASS_NAME =
  "relative flex-none px-3 pt-1 pb-[max(.75rem,env(safe-area-inset-bottom))] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-linear-to-t before:from-background before:to-background/0 sm:mx-auto sm:w-full sm:max-w-[780px] sm:px-0 sm:pb-0";

/** The draft's text box, the same in the live composer and its loading veil. */
export const COMPOSER_INPUT_CLASS_NAME =
  "min-h-[36px] w-full resize-none bg-transparent px-1 py-1 text-reading leading-6 text-foreground outline-none placeholder:text-faint";

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
      className={cn("flex flex-col gap-1.5", className)}
    >
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
        <span className="flex h-9 min-w-0 items-center px-1">
          <span className="auni-loading-sheen h-3 w-[min(68%,220px)] rounded-full" />
        </span>
      )}
      <div className="flex items-center justify-end gap-2">
        <span aria-hidden className="auni-loading-sheen h-7 w-28 rounded-full" />
        <span aria-hidden className="flex size-9 flex-none items-center justify-center">
          <span className="size-8 rounded-full bg-foreground/[0.07]" />
        </span>
      </div>
    </div>
  );
}

/** Noninteractive composer with the same box model as the live form. */
export function ComposerLoadingSurface() {
  return (
    <div className="flex flex-col">
      <div className={COMPOSER_SURFACE_CLASS_NAME}>
        <ComposerLoadingLayout />
      </div>
      <div aria-hidden className="mt-2 flex h-7 items-center justify-between px-2">
        <span className="auni-loading-sheen h-4 w-28 rounded-md" />
        <span className="auni-loading-sheen h-4 w-20 rounded-md" />
      </div>
    </div>
  );
}
