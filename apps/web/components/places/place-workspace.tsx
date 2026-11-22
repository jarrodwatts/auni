"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ConversationLaunchProvider } from "@/components/app/conversation-launch-context";
import { ConversationLaunchStage } from "@/components/app/conversation-launch-stage";
import { useFirstRun } from "@/components/first-run/use-first-run";
import { WelcomeWizard } from "@/components/onboarding/welcome-wizard";
import { CloseMobileThreadMenuContext } from "@/components/app/mobile-thread-menu";
import { useLiveThreadRows } from "@/components/app/use-threads";
import { useSpecialist } from "@/components/specialist/use-specialists";
import { AuniSheet } from "@/components/ui/auni-sheet";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import { ArrivingContext } from "./arriving";
import { SpecialistPane } from "./specialist-pane";
import { PlaceLayoutContext, type PlacesSheet } from "./place-header";
import { SearchProvider } from "./search-palette";
import { PhonePlaces, Sidebar } from "./sidebar";
import { useStoredFlag } from "./stored-state";
import { usePlaceRoute } from "./use-places";

/**
 * Three panes, like a code editor: the team on the left, the place you're in
 * down the middle, and, for a specialist, everything about it on the right.
 * Both side panes fold; the middle never does. Handoffs play over the middle alone.
 */
export function PlaceWorkspace({ children }: { readonly children: ReactNode }) {
  useLiveThreadRows();
  return (
    <ConversationLaunchProvider>
      <SearchProvider>
        <PlaceShell>
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
            <ConversationLaunchStage />
          </div>
        </PlaceShell>
        {/* First run's local-first onboarding wizard, over the app until completed or skipped. */}
        <WelcomeWizard />
      </SearchProvider>
    </ConversationLaunchProvider>
  );
}

function PlaceShell({ children }: { readonly children: ReactNode }) {
  const route = usePlaceRoute();
  // First run is the landing alone; the app assembles around the take as it's sent.
  const firstRun = useFirstRun();
  const [wasFirstRun, setWasFirstRun] = useState(firstRun);
  const [arriving, setArriving] = useState(false);
  if (wasFirstRun !== firstRun) {
    setWasFirstRun(firstRun);
    setArriving(!firstRun);
  }
  const [railed, setRailed] = useStoredFlag("auni:sidebar-rail", false);
  const [paneOpen, setPaneOpen] = useStoredFlag("auni:money-pane", true);
  // Below the pane's breakpoint the pane comes up as a sheet instead.
  const wide = useMediaQuery("(min-width: 1280px)");
  const roomy = useMediaQuery("(min-width: 1024px)");
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlacesSheet | null>(null);
  const closePlaces = useCallback(() => setPlaces(null), []);
  const place = route.kind === "specialist" ? route.id : route.kind;
  const sheetOpen = sheetFor === place && !wide;
  const showPane = useCallback(() => {
    if (wide) setPaneOpen(true);
    else setSheetFor(place);
  }, [place, setPaneOpen, wide]);
  const layout = useMemo(
    () => ({ paneOpen, setPaneOpen, showPane, places, openPlaces: setPlaces }),
    [paneOpen, places, setPaneOpen, showPane],
  );
  const pane = route.kind === "specialist" ? <SpecialistPane specialistId={route.id} /> : null;
  // Not read yet (a specialist just started) means no pane: it grows in once the specialist is known.
  const { specialist } = useSpecialist(route.kind === "specialist" ? route.id : undefined);
  const paneShown = paneOpen && specialist !== undefined;
  const paneTitle = specialist?.name ?? "Specialist";

  return (
    <PlaceLayoutContext value={layout}>
      <ArrivingContext value={arriving}>
        <div className="relative flex h-dvh overflow-hidden bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
          {firstRun ? null : (
            <div className="hidden h-full lg:flex">
              <Sidebar folded={railed} onFold={setRailed} />
            </div>
          )}
          {/* In first run the landing over it is the main content, where the skip link goes. */}
          <main
            id={firstRun ? undefined : "main-content"}
            className="flex min-w-0 flex-1 flex-col bg-background"
          >
            {children}
          </main>
          {pane ? (
            // The pane narrows closed rather than vanishing; what it holds rides out with the edge.
            <aside
              aria-label={paneTitle}
              inert={!paneShown}
              className={cn(
                "hidden h-full flex-none overflow-hidden border-l bg-background transition-[width,border-color] duration-[340ms] ease-settle motion-reduce:transition-none xl:block",
                paneShown ? "w-[392px] border-foreground/[0.07]" : "w-0 border-transparent",
              )}
            >
              <div
                className={cn(
                  "auni-scrollbar-none h-full w-[392px] overflow-y-auto transition-opacity duration-200 ease-settle motion-reduce:transition-none",
                  paneShown ? "opacity-100 delay-75" : "opacity-0",
                )}
              >
                {pane}
              </div>
            </aside>
          ) : null}
          {pane ? (
            <AuniSheet
              open={sheetOpen}
              onOpenChange={(open) => setSheetFor(open ? place : null)}
              side={roomy ? "right" : "bottom"}
              title={paneTitle}
            >
              <div className="auni-scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
                {pane}
              </div>
            </AuniSheet>
          ) : null}
          <CloseMobileThreadMenuContext value={closePlaces}>
            <AuniSheet
              open={places === "menu"}
              onOpenChange={(open) => setPlaces(open ? "menu" : null)}
              side="left"
              title="Places"
              className="bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
            >
              <Sidebar mobile />
            </AuniSheet>
            <AuniSheet
              open={places === "switcher"}
              onOpenChange={(open) => setPlaces(open ? "switcher" : null)}
              side="bottom"
              title="Places"
            >
              {/* A set height, so typing a search never resizes the sheet under the thumb. */}
              <div className="flex h-[min(680px,82dvh)] min-h-0 flex-col pt-6">
                <PhonePlaces />
              </div>
            </AuniSheet>
          </CloseMobileThreadMenuContext>
        </div>
      </ArrivingContext>
    </PlaceLayoutContext>
  );
}
