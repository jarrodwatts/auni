"use client";

import { ChevronLeft, Menu, PanelRight } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { HEADER_BUTTON_CLASS_NAME } from "@/components/app/mobile-thread-menu";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";
import { PlaceSwitcher } from "./place-switcher";

interface PlaceLayout {
  /** Whether the pane beside the conversation is open (wide screens). */
  readonly paneOpen: boolean;
  readonly setPaneOpen: (open: boolean) => void;
  /** Brings the place's pane into view: beside the conversation when there's room, a sheet when not. */
  readonly showPane: () => void;
  /**
   * A phone's places sheet that is up: the menu from the left, or the switcher from the
   * bottom. The workspace holds them, so one closes in its own time as the next place opens.
   */
  readonly places: PlacesSheet | null;
  readonly openPlaces: (sheet: PlacesSheet) => void;
}

export type PlacesSheet = "menu" | "switcher";

export const PlaceLayoutContext = createContext<PlaceLayout>({
  paneOpen: true,
  setPaneOpen: () => undefined,
  showPane: () => undefined,
  places: null,
  openPlaces: () => undefined,
});

export function usePlaceLayout(): PlaceLayout {
  return useContext(PlaceLayoutContext);
}

/**
 * Where you are, above the conversation: the place's mark and name, and
 * when its pane is closed (or the screen too narrow for it), what it is
 * worth, which opens the pane; one with no money has the pane's button
 * instead. `actions` holds the place's own menu. On a phone, Portfolio
 * opens the places menu; every other place goes back to it, and its name
 * switches to any other place.
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
  /** Portfolio, where every place leads back to. */
  readonly root?: boolean;
  /** The place has a pane to toggle. */
  readonly pane?: boolean;
  /** A stand-in drawn during a handoff: same footprint, nothing live. */
  readonly preview?: boolean;
  readonly className?: string;
}) {
  const { openPlaces, paneOpen, places, setPaneOpen, showPane } = usePlaceLayout();
  return (
    <header
      className={cn(
        "relative z-30 flex h-[56px] flex-none items-center gap-2.5 border-b border-foreground/[0.06] bg-background px-3 sm:px-4 lg:px-5",
        className,
      )}
    >
      {root ? (
        <button
          type="button"
          aria-label="Open places"
          aria-haspopup="dialog"
          aria-expanded={places === "menu"}
          onClick={() => openPlaces("menu")}
          className={HEADER_BUTTON_CLASS_NAME}
        >
          <Menu aria-hidden className="size-[18px]" />
        </button>
      ) : (
        <BackToPortfolio preview={preview} />
      )}
      {root || preview ? (
        <>
          {icon ? <span className="flex flex-none items-center">{icon}</span> : null}
          <h1 className="min-w-0 truncate text-ui font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h1>
        </>
      ) : (
        <PlaceSwitcher icon={icon} title={title} />
      )}
      <div className="ml-auto flex flex-none items-center gap-2">
        {money && pane && !preview ? (
          // The value is the way to the money whenever its pane isn't showing.
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={showPane}
            className={cn(
              "flex h-8 items-center gap-2 rounded-full px-3 text-ui transition-colors duration-200 hover:bg-foreground/[0.06] focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none max-xl:bg-foreground/[0.04] max-sm:gap-1.5 max-sm:px-2.5",
              // Each time the pane closes, the value eases in to stand for it.
              "duration-300 ease-settle motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2",
              paneOpen && "xl:hidden",
            )}
          >
            <span className="sr-only">Show details: </span>
            {money}
          </button>
        ) : money ? (
          <span className="mr-1 flex items-baseline gap-2 text-ui">{money}</span>
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
                className="flex size-8 items-center justify-center rounded-card text-faint transition-colors duration-200 hover:bg-foreground/[0.05] hover:text-ink xl:hidden"
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
                "hidden size-8 items-center justify-center rounded-card transition-colors duration-200 xl:flex",
                paneOpen
                  ? "bg-foreground/[0.05] text-ink"
                  : "text-faint hover:bg-foreground/[0.05] hover:text-ink",
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
 * A phone's one tap home from any place; wide screens have the sidebar instead.
 * The preview draws outside the app's providers, which PlaceLink reads, so it
 * gets a bare chevron.
 */
export function BackToPortfolio({ preview }: { readonly preview: boolean }) {
  if (preview)
    return (
      <span aria-hidden className={cn(HEADER_BUTTON_CLASS_NAME, "-mr-1.5")}>
        {BACK_CHEVRON}
      </span>
    );
  return (
    <PlaceLink
      href="/app"
      aria-label="Back to Portfolio"
      className={cn(HEADER_BUTTON_CLASS_NAME, "-mr-1.5")}
    >
      {BACK_CHEVRON}
    </PlaceLink>
  );
}
