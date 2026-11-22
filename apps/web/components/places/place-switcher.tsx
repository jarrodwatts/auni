"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { usePlaceLayout } from "./place-header";

/**
 * On a phone, a place's name is also the way to every other place: tapped,
 * it brings up the places as a sheet from the bottom, the one you're in
 * marked. On a wide screen the sidebar is already showing, so it's only a name.
 */
export function PlaceSwitcher({
  icon,
  title,
}: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
}) {
  const { openPlaces, places } = usePlaceLayout();
  return (
    <h1 className="flex min-w-0">
      <button
        type="button"
        data-switcher
        aria-haspopup="dialog"
        aria-expanded={places === "switcher"}
        onClick={() => openPlaces("switcher")}
        className="-ml-1.5 flex h-10 min-w-0 items-center gap-2 rounded-control px-1.5 outline-none transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/40 active:bg-foreground/[0.06] lg:pointer-events-none"
      >
        {icon ? <span className="flex flex-none items-center">{icon}</span> : null}
        <span className="min-w-0 truncate text-ui font-semibold tracking-[-0.01em] text-ink">
          {title}
        </span>
        <ChevronDown
          aria-hidden
          className="-ml-0.5 size-4 flex-none text-faint lg:hidden"
          strokeWidth={2.25}
        />
        <span className="sr-only">, switch places</span>
      </button>
    </h1>
  );
}
