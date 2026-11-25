"use client";

import type { AppWire } from "@auni/shared";
import { LayoutGrid } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { ThreadFailureNotice } from "@/components/app/thread-failure-notice";
import { PlaceHeader } from "@/components/places/place-header";
import { Badge } from "@/components/ui/badge";
import { Row, Rows } from "@/components/ui/row";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_SHEET_PARAM, appHref, dialogClosedHref } from "@/lib/app-links";
import { useApps } from "@/lib/data/apps";
import { cn } from "@/lib/utils";

import { AppMark } from "./app-mark";
import { AppSheet } from "./app-sheet";
import { appStanding } from "./app-standing";
import { BehindTheScenes, isYours } from "./runs-on";

const READ_FAILURE = { message: "Your apps couldn't load.", action: "reload" } as const;

/** Where the owner's money is comes first, largest first; then by name, with one turned off last. */
function byWhatMatters(a: AppWire, b: AppWire): number {
  const usd = (app: AppWire) => Number(app.account?.usd ?? 0);
  return Number(!a.on) - Number(!b.on) || usd(b) - usd(a) || a.name.localeCompare(b.name);
}

/**
 * Apps: the services the owner acts through, each a row with what they hold there or the one
 * thing in its way, and under them the services Auni uses on its own. Their AI, their wallet
 * and their chats live in Settings, so they aren't here twice. Any app opens its sheet, which the
 * address keeps (`?app=<id>`), so a link can open one.
 */
export function AppsScreen() {
  const apps = useApps();
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
  // Each row keeps the place it had when the page was opened: one just turned off stays put.
  const [places, setPlaces] = useState<ReadonlyMap<string, number> | null>(null);
  if (apps.data && !places)
    setPlaces(
      new Map(
        all
          .filter(isYours)
          .toSorted(byWhatMatters)
          .map(({ id }, place) => [id, place]),
      ),
    );
  const placeOf = (id: string) => places?.get(id) ?? Number.MAX_SAFE_INTEGER;
  const yours = all
    .filter(isYours)
    .toSorted((a, b) => placeOf(a.id) - placeOf(b.id) || byWhatMatters(a, b));
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
            "mx-auto flex w-full max-w-[720px] flex-col gap-12 px-4 pt-6 pb-24 sm:px-8 sm:pt-10",
            apps.data && !loadedOnArrival && "auni-stagger-in",
          )}
        >
          {apps.isError && !apps.data ? (
            <ThreadFailureNotice failure={READ_FAILURE} onRetry={() => void apps.refetch()} />
          ) : !apps.data ? (
            <Loading />
          ) : (
            <>
              <section aria-labelledby="apps-yours">
                <h2 id="apps-yours" className="text-title text-ink">
                  Apps
                </h2>
                <p className="mt-1 text-ui text-muted-foreground">
                  Where Auni trades and what it reads.
                </p>
                <Rows className="mt-5 rounded-card border border-border bg-card px-4">
                  {yours.map((app) => (
                    <li key={app.id}>
                      <AppRow app={app} onOpen={() => open(app.id)} />
                    </li>
                  ))}
                </Rows>
              </section>
              <BehindTheScenes apps={all} onOpen={open} />
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

/** One app the owner acts through: its logo and name, what it's for, and how it stands. */
function AppRow({ app, onOpen }: { readonly app: AppWire; readonly onOpen: () => void }) {
  const { money, badge } = appStanding(app);
  return (
    <Row
      asChild
      aria-haspopup="dialog"
      data-testid="app-row"
      data-app={app.id}
      className="min-h-[72px]"
      mark={
        <span className={cn(!app.on && "opacity-55 grayscale")}>
          <AppMark id={app.id} name={app.name} size={40} />
        </span>
      }
      title={app.name}
      meta={app.does}
      end={
        money || badge ? (
          <span className="flex flex-col items-end gap-1">
            {money ? (
              <span
                className={cn(
                  "text-ui font-medium tabular-nums",
                  app.on ? "text-ink" : "text-muted-foreground",
                )}
              >
                {money}
              </span>
            ) : null}
            {badge ? <Badge tone={badge.tone}>{badge.says}</Badge> : null}
          </span>
        ) : null
      }
    >
      <button type="button" onClick={onOpen} />
    </Row>
  );
}

function Loading() {
  return (
    <div className="auni-appear-late">
      <Skeleton className="h-8 w-28 rounded-control" />
      <Skeleton className="mt-2 h-4 w-64 max-w-full rounded-control" />
      <Skeleton className="mt-5 h-[288px] rounded-card" />
    </div>
  );
}
