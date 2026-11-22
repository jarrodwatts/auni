"use client";

import type { AppWire } from "@auni/shared";
import { Cpu, LayoutGrid, MessageSquare, WalletMinimal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { ThreadFailureNotice } from "@/components/app/thread-failure-notice";
import { PlaceHeader } from "@/components/places/place-header";
import { PortfolioSection } from "@/components/portfolio/portfolio-section";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_SHEET_PARAM, appHref, dialogClosedHref } from "@/lib/app-links";
import { useApps } from "@/lib/data/apps";
import { cn } from "@/lib/utils";

import { AppSheet } from "./app-sheet";
import { AppTile } from "./app-tile";
import { RunsOn } from "./runs-on";

const READ_FAILURE = { message: "Your apps couldn't load.", action: "reload" } as const;

/** Tiles in as many columns as fit, one on a phone. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3";

/** Where the owner's money is comes first, largest first; then by name, with one turned off last. */
function byWhatMatters(a: AppWire, b: AppWire): number {
  const usd = (app: AppWire) => Number(app.account?.usd ?? 0);
  return Number(!a.on) - Number(!b.on) || usd(b) - usd(a) || a.name.localeCompare(b.name);
}

/**
 * Everything Auni does for the owner goes through an app. "Your apps" are the services they act
 * through, each a tile with what they hold there or the one thing it still needs; "What Auni
 * runs on" is the plumbing under it, by the job each does, with no switch. Any of them opens its
 * sheet, which the address keeps (`?app=<id>`), so a link can open one.
 */
export function AppsScreen() {
  const apps = useApps();
  const { openSettings } = useAppDialogs();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openId = searchParams.get(APP_SHEET_PARAM);
  // The sheet keeps the app it last showed while it slides away.
  const [shown, setShown] = useState(openId);
  if (openId && openId !== shown) setShown(openId);
  // Content that was already here simply shows; only content that had to load rises in.
  const [loadedOnArrival] = useState(Boolean(apps.data));

  // Opening a sheet adds a step to the browser's history, so Back closes it; closing it any
  // other way takes that step back out, so one Back then leaves Apps. A sheet a link opened
  // has no step of its own behind it, and one opened from another takes that one's place.
  const [stepFor, setStepFor] = useState<string | null>(null);
  const open = (id: string) => {
    if (openId) router.replace(appHref(id), { scroll: false });
    else router.push(appHref(id), { scroll: false });
    setStepFor(openId && stepFor !== openId ? null : id);
  };
  const close = () => {
    if (stepFor === openId) router.back();
    else
      router.replace(dialogClosedHref(pathname, searchParams.toString(), APP_SHEET_PARAM), {
        scroll: false,
      });
    setStepFor(null);
  };

  const all = apps.data?.apps ?? [];
  const isVenueOrData = (app: AppWire) => app.canSwitch && app.pairing === null;
  // Each tile keeps the place it had when the page was opened: one just turned off stays put.
  const [places, setPlaces] = useState<ReadonlyMap<string, number> | null>(null);
  if (apps.data && !places)
    setPlaces(
      new Map(
        all
          .filter(isVenueOrData)
          .toSorted(byWhatMatters)
          .map(({ id }, place) => [id, place]),
      ),
    );
  const placeOf = (id: string) => places?.get(id) ?? Number.MAX_SAFE_INTEGER;
  const yours = all
    .filter(isVenueOrData)
    .toSorted((a, b) => placeOf(a.id) - placeOf(b.id) || byWhatMatters(a, b));
  const plumbing = all.filter(({ canSwitch }) => !canSwitch);
  const sheet = all.find(({ id }) => id === shown);

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col">
      <PlaceHeader
        root
        icon={<LayoutGrid aria-hidden className="size-5 text-ink" strokeWidth={2} />}
        title="Apps"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex w-full max-w-[960px] flex-col gap-10 px-4 pt-6 pb-24 sm:px-8",
            apps.data && !loadedOnArrival && "auni-stagger-in",
          )}
        >
          {apps.isError && !apps.data ? (
            <ThreadFailureNotice failure={READ_FAILURE} onRetry={() => void apps.refetch()} />
          ) : !apps.data ? (
            <Loading />
          ) : (
            <>
              <section aria-label="Your apps">
                <h2 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em] text-ink">
                  Venues &amp; data apps
                </h2>
                <p className="mt-1.5 max-w-[540px] text-ui leading-[1.5] font-normal text-muted-foreground">
                  The financial venues and research services Auni acts through. Open one to see what
                  you hold there, configure keys, or turn it on or off.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
                  <span>Looking for system setup?</span>
                  <button
                    type="button"
                    onClick={() => openSettings("brains")}
                    className="inline-flex items-center gap-1.5 rounded-full border border-foreground/[0.08] bg-card px-3 py-1 font-medium text-ink transition-colors hover:bg-foreground/[0.04]"
                  >
                    <Cpu className="size-3.5 text-muted-foreground" />
                    AI Brains
                  </button>
                  <button
                    type="button"
                    onClick={() => openSettings("wallet")}
                    className="inline-flex items-center gap-1.5 rounded-full border border-foreground/[0.08] bg-card px-3 py-1 font-medium text-ink transition-colors hover:bg-foreground/[0.04]"
                  >
                    <WalletMinimal className="size-3.5 text-muted-foreground" />
                    Wallet &amp; Keys
                  </button>
                  <button
                    type="button"
                    onClick={() => openSettings("channels")}
                    className="inline-flex items-center gap-1.5 rounded-full border border-foreground/[0.08] bg-card px-3 py-1 font-medium text-ink transition-colors hover:bg-foreground/[0.04]"
                  >
                    <MessageSquare className="size-3.5 text-muted-foreground" />
                    Channels
                  </button>
                </div>
                <ul className={cn(GRID, "mt-5")}>
                  {yours.map((app) => (
                    <li key={app.id} className="flex min-w-0">
                      <AppTile app={app} onOpen={() => open(app.id)} />
                    </li>
                  ))}
                </ul>
              </section>
              <PortfolioSection title="What Auni runs on">
                <RunsOn apps={plumbing} onOpen={open} />
              </PortfolioSection>
            </>
          )}
        </div>
      </div>
      {sheet ? (
        <AppSheet
          key={sheet.id}
          app={sheet}
          apps={all}
          onOpen={open}
          settingsFile={apps.data?.settingsFile ?? ""}
          whichBrain={apps.data?.whichBrain ?? null}
          open={openId === sheet.id}
          onOpenChange={(next) => (next ? undefined : close())}
        />
      ) : null}
    </section>
  );
}

function Loading() {
  return (
    <div className="auni-appear-late">
      <Skeleton className="h-8 w-40 rounded-lg" />
      <Skeleton className="mt-3 h-4 w-72 max-w-full rounded-md" />
      <div className={cn(GRID, "mt-5")}>
        {[0, 1, 2, 3, 4].map((key) => (
          <Skeleton key={key} className="h-[172px] rounded-[22px]" />
        ))}
      </div>
    </div>
  );
}
