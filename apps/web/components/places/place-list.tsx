"use client";

import { ChevronRight, Hand, LayoutGrid } from "lucide-react";
import { useState } from "react";

import { useMoney } from "@/components/money/money-provider";
import { APPS_HREF, NEEDS_YOU_HREF, chatHref } from "@/lib/app-links";
import { formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";

import { ChatRow } from "./chat-row";
import { PortfolioMark, TakeFigures, WaitingCount } from "./place-marks";
import {
  FOLD_FADE,
  ICON_CLASS_NAME,
  ICON_STROKE,
  PlaceRow,
  ROW_CLASS_NAME,
  ROW_LINE_CLASS_NAME,
  SectionLabel,
} from "./sidebar-rows";
import { type ChatPlace, type PlaceRoute, usePlaceRoute, usePlaces } from "./use-places";

/** Chats shown before "Show more"; one that is open always shows. */
const RECENT_CHATS = 12;

function visibleChats(chats: readonly ChatPlace[], route: PlaceRoute): readonly ChatPlace[] {
  return chats.filter(
    ({ thread }, index) =>
      index < RECENT_CHATS || thread.pinned || (route.kind === "chat" && route.id === thread.id),
  );
}

/** How many chats wait on the owner, as a phone's Chats leads to them: "2 need you". */
function needYou(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

/** What a waiting chat asks of the person, in full: a sale's floor comes with its condition. */
export function askOf({ thread }: ChatPlace): string {
  return thread.moneyLine ?? "Waiting for your answer";
}

/**
 * The places, then every chat in the one place it belongs: Needs you while something in it
 * waits on the person, Your takes while it holds something, and Chats for the rest. On a phone's
 * Chats page (`nav={false}`) the tab bar holds Money, Needs you and the rest, so only the chats
 * show, under one row that leads to Needs you.
 */
export function PlaceList({
  folded = false,
  nav = true,
}: {
  readonly folded?: boolean;
  readonly nav?: boolean;
}) {
  const route = usePlaceRoute();
  const places = usePlaces();
  const { portfolio } = useMoney();
  const [allChats, setAllChats] = useState(false);

  const shownChats = allChats ? places.others : visibleChats(places.others, route);
  const hiddenChats = places.others.length - shownChats.length;
  const isOpen = (place: ChatPlace) => route.kind === "chat" && route.id === place.thread.id;

  return (
    <>
      {nav ? (
        <>
          <PlaceRow
            active={route.kind === "portfolio" || route.kind === "activity"}
            folded={folded}
            href="/app"
            mark={<PortfolioMark className={ICON_CLASS_NAME} />}
            title="Money"
            trailing={
              portfolio ? (
                <span className="text-meta text-muted-foreground tabular-nums lining-nums">
                  {formatUsdcBalance(BigInt(portfolio.totalUsd.baseUnits))}
                </span>
              ) : null
            }
          />
          <PlaceRow
            active={route.kind === "apps"}
            folded={folded}
            href={APPS_HREF}
            mark={<LayoutGrid aria-hidden className={ICON_CLASS_NAME} strokeWidth={ICON_STROKE} />}
            title="Apps"
            className="mt-px"
          />
        </>
      ) : null}

      {places.needsYou.length > 0 ? (
        <div className="mt-5 first:mt-0">
          <PlaceRow
            active={route.kind === "needs-you"}
            folded={folded}
            href={NEEDS_YOU_HREF}
            mark={
              nav ? (
                <WaitingCount count={places.waitingCount} className="px-1" />
              ) : (
                <Hand aria-hidden className="size-[18px] text-waiting" strokeWidth={ICON_STROKE} />
              )
            }
            title={nav ? "Needs you" : needYou(places.waitingCount)}
            titleClassName="font-medium text-waiting"
            trailing={nav ? null : <ChevronRight aria-hidden className="size-4 text-faint" />}
          />
          {/* On a phone's Chats the tab holds the list itself; one row leads to it. */}
          {nav ? (
            <ul inert={folded} className={cn("flex flex-col gap-px", FOLD_FADE)}>
              {places.needsYou.map((place) => (
                <ChatRow
                  key={place.thread.id}
                  active={isOpen(place)}
                  href={chatHref(place.thread.id)}
                  thread={place.thread}
                  status={place.status}
                  detail={<span className="text-waiting">{askOf(place)}</span>}
                  wrapDetail
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {places.takes.length > 0 ? (
        <div inert={folded} className={FOLD_FADE}>
          <SectionLabel>Your takes</SectionLabel>
          <ul className="flex flex-col gap-px">
            {places.takes.map((place) => (
              <ChatRow
                key={place.thread.id}
                active={isOpen(place)}
                href={chatHref(place.thread.id)}
                thread={place.thread}
                status={place.status}
                detail={place.take ? <TakeFigures take={place.take} /> : null}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {places.others.length > 0 ? (
        <div inert={folded} className={FOLD_FADE}>
          <SectionLabel>Chats</SectionLabel>
          <ul className="flex flex-col gap-px">
            {shownChats.map((place) => (
              <ChatRow
                key={place.thread.id}
                active={isOpen(place)}
                href={chatHref(place.thread.id)}
                thread={place.thread}
                status={place.status}
              />
            ))}
          </ul>
          {(allChats ? places.others.length > RECENT_CHATS : hiddenChats > 0) ? (
            <button
              type="button"
              onClick={() => setAllChats(!allChats)}
              className={cn(
                ROW_CLASS_NAME,
                ROW_LINE_CLASS_NAME,
                "mt-px w-full text-muted-foreground hover:text-ink",
              )}
            >
              {allChats ? "Show less" : `Show ${hiddenChats} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
