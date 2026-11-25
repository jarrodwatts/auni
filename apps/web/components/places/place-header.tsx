"use client";

import { ChevronLeft, PanelRight } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { HEADER_BUTTON_CLASS_NAME } from "@/components/app/mobile-thread-menu";
import { buttonVariants } from "@/components/ui/button";
import { CHATS_HREF } from "@/lib/app-links";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";

interface PlaceLayout {
  /** Whether the pane beside the conversation is open (wide screens). */
  readonly paneOpen: boolean;
  readonly setPaneOpen: (open: boolean) => void;
  /** Brings the place's pane into view: beside the conversation when there's room, a sheet when not. */
  readonly showPane: () => void;
}

export const PlaceLayoutContext = createContext<PlaceLayout>({
  paneOpen: true,
  setPaneOpen: () => undefined,
  showPane: () => undefined,
});

function usePlaceLayout(): PlaceLayout {
  return useContext(PlaceLayoutContext);
}

/**
 * Where you are: the place's mark and name, and when its pane is closed (or the screen too narrow
 * for it), what it is worth, which opens the pane; one with no money has the pane's button
 * instead. `actions` holds the place's own menu. On a phone a `root` place (one the tab bar or
 * More reaches) has no way back, as the tab bar is under it; a chat goes back to Chats.
 */
export function PlaceHeader({
  icon,
  title,
  money,
  actions,
  root = false,
  pane = false,
  preview = false,
  className,
}: {
  /** A place's mark; a chat has none and leads with its words. */
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly money?: ReactNode;
  readonly actions?: ReactNode;
  /** A place of its own, not a chat: on a phone the tab bar is the way on, so no back. */
  readonly root?: boolean;
  /** The place has a pane to toggle. */
  readonly pane?: boolean;
  /** A stand-in drawn during a handoff: same footprint, nothing live. */
  readonly preview?: boolean;
  readonly className?: string;
}) {
  const { paneOpen, setPaneOpen, showPane } = usePlaceLayout();
  return (
    <header
      className={cn(
        "relative z-30 flex h-[56px] flex-none items-center gap-2.5 border-b border-foreground/[0.06] bg-background px-3 sm:px-4 lg:px-5",
        className,
      )}
    >
      {root ? null : <BackToChats preview={preview} />}
      {icon ? <span className="flex flex-none items-center">{icon}</span> : null}
      <h1 className="min-w-0 truncate text-ui font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h1>
      <div className="ml-auto flex flex-none items-center gap-2">
        {money && pane && !preview ? (
          // The value is the way to the money whenever its pane isn't showing.
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={showPane}
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "gap-2.5 text-ui text-ink max-xl:bg-foreground/[0.04] max-sm:gap-2 max-sm:px-2.5",
              // Each time the pane closes, the value eases in to stand for it.
              "duration-300 ease-settle motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2",
              paneOpen && "xl:hidden",
            )}
          >
            <span className="sr-only">Show take details: </span>
            {money}
          </button>
        ) : money ? (
          <span className="mr-1 flex items-baseline gap-2 text-ui tabular-nums">{money}</span>
        ) : null}
        {actions}
        {pane && !preview ? (
          <>
            {/* Without the room for the pane, and no value to open it by, this opens it as a sheet. */}
            {money ? null : (
              <button
                type="button"
                aria-label="Show details"
                aria-haspopup="dialog"
                onClick={showPane}
                className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "xl:hidden")}
              >
                <PanelRight aria-hidden className="size-[17px]" />
              </button>
            )}
            <button
              type="button"
              aria-label={paneOpen ? "Hide details" : "Show details"}
              aria-pressed={paneOpen}
              onClick={() => setPaneOpen(!paneOpen)}
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon-sm" }),
                "hidden xl:inline-flex",
                paneOpen && "bg-foreground/[0.05] text-ink",
              )}
            >
              <PanelRight aria-hidden className="size-[17px]" />
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

const BACK_CHEVRON = <ChevronLeft aria-hidden className="size-[22px]" strokeWidth={2} />;

/**
 * A phone's one tap from a chat back to the list of them; wide screens have the sidebar instead.
 * The preview draws outside the app's providers, which PlaceLink reads, so it gets a bare chevron.
 */
function BackToChats({ preview }: { readonly preview: boolean }) {
  if (preview)
    return (
      <span aria-hidden className={cn(HEADER_BUTTON_CLASS_NAME, "-mr-1.5")}>
        {BACK_CHEVRON}
      </span>
    );
  return (
    <PlaceLink
      href={CHATS_HREF}
      aria-label="Back to chats"
      className={cn(HEADER_BUTTON_CLASS_NAME, "-mr-1.5")}
    >
      {BACK_CHEVRON}
    </PlaceLink>
  );
}
