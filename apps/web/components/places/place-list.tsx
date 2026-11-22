"use client";

import { LayoutGrid, ReceiptText } from "lucide-react";
import { useState } from "react";

import { useActivity } from "@/components/activity/use-activity";
import { APPS_HREF, chatHref } from "@/lib/app-links";
import { cn } from "@/lib/utils";

import { ChatRow } from "./chat-row";
import { PortfolioMark, UnreadCount, WaitingCount, WaitingDot } from "./place-marks";
import {
  FOLD_FADE,
  ICON_CLASS_NAME,
  ICON_STROKE,
  PlaceRow,
  RAIL_FADE,
  ROW_CLASS_NAME,
  ROW_LINE_CLASS_NAME,
  SectionLabel,
} from "./sidebar-rows";
import { type ChatPlace, type PlaceRoute, usePlaceRoute, usePlaces } from "./use-places";

/** Recent threads shown before "Show more"; one that is open always shows. */
const RECENT_THREADS = 12;

function visibleRecent(chats: readonly ChatPlace[], route: PlaceRoute): readonly ChatPlace[] {
  return chats.filter(
    ({ thread, waiting }, index) =>
      index < RECENT_THREADS || waiting || (route.kind === "chat" && route.id === thread.id),
  );
}

/**
 * Unified navigation list: Portfolio, Activity, Apps, then Threads grouped into
 * Pinned, Active (waiting, running, watching, or Auto), and Recent.
 */
export function PlaceList({ folded = false }: { readonly folded?: boolean }) {
  const route = usePlaceRoute();
  const places = usePlaces();
  const unread = useActivity().data?.unread ?? 0;
  const [allRecent, setAllRecent] = useState(false);

  const shownRecent = allRecent ? places.recent : visibleRecent(places.recent, route);
  const hiddenRecent = places.recent.length - shownRecent.length;

  const renderThread = ({ thread, status }: ChatPlace) => (
    <ChatRow
      key={thread.id}
      active={route.kind === "chat" && route.id === thread.id}
      href={chatHref(thread.id)}
      thread={thread}
      status={status}
    />
  );

  return (
    <>
      <PlaceRow
        active={route.kind === "portfolio"}
        folded={folded}
        href="/app"
        mark={
          <>
            <PortfolioMark className={ICON_CLASS_NAME} />
            {places.waitingCount > 0 ? (
              <WaitingDot className={cn("-top-0.5 -right-0.5 size-2", RAIL_FADE)} />
            ) : null}
          </>
        }
        title="Portfolio"
        trailing={places.waitingCount > 0 ? <WaitingCount count={places.waitingCount} /> : null}
      />
      <PlaceRow
        active={route.kind === "activity"}
        folded={folded}
        href="/app/activity"
        mark={
          <>
            <ReceiptText aria-hidden className={ICON_CLASS_NAME} strokeWidth={ICON_STROKE} />
            {unread > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "absolute -top-0.5 -right-0.5 size-2 rounded-full bg-negative ring-2 ring-sidebar",
                  RAIL_FADE,
                )}
              />
            ) : null}
          </>
        }
        title="Activity"
        trailing={unread > 0 ? <UnreadCount count={unread} /> : null}
        className="mt-px"
      />
      <PlaceRow
        active={route.kind === "apps"}
        folded={folded}
        href={APPS_HREF}
        mark={<LayoutGrid aria-hidden className={ICON_CLASS_NAME} strokeWidth={ICON_STROKE} />}
        title="Apps"
        className="mt-px"
      />

      {places.pinned.length > 0 ? (
        <div inert={folded} className={FOLD_FADE}>
          <SectionLabel>Pinned</SectionLabel>
          <ul className="flex flex-col gap-px">{places.pinned.map(renderThread)}</ul>
        </div>
      ) : null}

      {places.active.length > 0 ? (
        <div inert={folded} className={FOLD_FADE}>
          <SectionLabel>Active</SectionLabel>
          <ul className="flex flex-col gap-px">{places.active.map(renderThread)}</ul>
        </div>
      ) : null}

      {places.recent.length > 0 ? (
        <div inert={folded} className={FOLD_FADE}>
          <SectionLabel>Threads</SectionLabel>
          <ul className="flex flex-col gap-px">{shownRecent.map(renderThread)}</ul>
          {(allRecent ? places.recent.length > RECENT_THREADS : hiddenRecent > 0) ? (
            <button
              type="button"
              onClick={() => setAllRecent(!allRecent)}
              className={cn(
                ROW_CLASS_NAME,
                ROW_LINE_CLASS_NAME,
                "mt-px w-full text-muted-foreground hover:text-ink",
              )}
            >
              {allRecent ? "Show less" : `Show ${hiddenRecent} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
