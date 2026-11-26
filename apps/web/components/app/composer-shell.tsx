"use client";

import { ArrowUp } from "lucide-react";

/** The reply box: the words, then one quiet bar inside it with the AI on the left and Send on the right. */
export const COMPOSER_SURFACE_CLASS_NAME =
  "relative flex flex-none flex-col rounded-sheet bg-card px-3 pt-2.5 pb-2 border border-border shadow-float";

/** Where the composer rests under a conversation; the talk above dissolves into it rather than being cut. */
export const COMPOSER_DOCK_CLASS_NAME =
  "relative flex-none px-3 pt-1 pb-[max(.75rem,env(safe-area-inset-bottom))] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-linear-to-t before:from-background before:to-background/0 sm:mx-auto sm:w-full sm:max-w-[780px] sm:px-0 sm:pb-0";

/** The draft's text box, shared with the grounded stand-in shown during route prefetches. */
export const COMPOSER_INPUT_CLASS_NAME =
  "min-h-[36px] w-full resize-none bg-transparent px-1 py-1 text-reading leading-6 text-foreground outline-none placeholder:text-faint";

/**
 * Calm, non-interactive composer matching the live box's exact geometry and
 * typography — no grey shimmer pills — while a route or thread resolves.
 */
export function ComposerStandin({ placeholder = "" }: { readonly placeholder?: string }) {
  return (
    <div aria-hidden className="flex flex-col">
      <div className={COMPOSER_SURFACE_CLASS_NAME}>
        <div className="flex flex-col gap-1.5">
          <span className="flex min-h-[36px] min-w-0 items-center truncate px-1 py-1 text-reading leading-6 text-faint">
            {placeholder}
          </span>
          <div className="flex items-center justify-end gap-1.5">
            <span className="flex size-9 flex-none items-center justify-center">
              <span className="flex size-8 items-center justify-center rounded-full bg-foreground/[0.07] text-foreground/35">
                <ArrowUp className="size-4" aria-hidden />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
