"use client";

import type { ThreadId } from "@auni/shared";
import { ChevronRight, LayoutGrid, ReceiptText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { useActivity } from "@/components/activity/use-activity";
import { useChangeThread } from "@/components/app/use-threads";
import { Mascot } from "@/components/brand/mascot";
import { APPS_HREF, chatHref } from "@/lib/app-links";
import { cn } from "@/lib/utils";

import { attentionOf } from "./attention";
import { ChatRow } from "./chat-row";
import { SpecialistRow } from "./specialist-row";
import {
  ATTENTION_LABEL,
  ChatStatusMark,
  PortfolioMark,
  UnreadCount,
  WaitingCount,
  WaitingDot,
} from "./place-marks";
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
import { useStoredFlag } from "./stored-state";
import { inHistory, teamOf } from "./team";
import { type ChatPlace, type PlaceRoute, usePlaceRoute, usePlaces } from "./use-places";

/** Older chats shown in History before "Show more"; one that waits on you or is open always shows. */
const RECENT_CHATS = 6;

function recentChats(chats: readonly ChatPlace[], route: PlaceRoute): readonly ChatPlace[] {
  return chats.filter(
    ({ thread, waiting }, index) =>
      index < RECENT_CHATS || waiting || (route.kind === "chat" && route.id === thread.id),
  );
}

/**
 * Every place as rows: Portfolio with what waits on you, Activity with what happened to your
 * money that you haven't seen, Apps (the services Auni acts through), then the team: Auni first, each specialist at work with how it is
 * going, and History folded under them, holding the retired ones and older chats. The sidebar's
 * and the phone sheets' own zone.
 */
export function PlaceList({ folded = false }: { readonly folded?: boolean }) {
  const route = usePlaceRoute();
  const places = usePlaces();
  const team = teamOf(places.specialists, places.chats);
  const unread = useActivity().data?.unread ?? 0;
  const changeThread = useChangeThread();
  const router = useRouter();
  const [historyOpen, setHistoryOpen] = useStoredFlag("auni:history-open", false);
  const [allChats, setAllChats] = useState(false);
  // History opens itself for the place open in it, so the sidebar always shows where you are.
  const showHistory = historyOpen || inHistory(team, route);
  const shownChats = allChats ? team.olderChats : recentChats(team.olderChats, route);
  const hiddenChats = team.olderChats.length - shownChats.length;
  const historyWaits = [...team.retired, ...team.olderChats].some(({ waiting }) => waiting);

  /** A retired specialist's conversation, put away; it leaves the sidebar. */
  const archive = (thread: ThreadId, open: boolean) => {
    // The open one is put away too, so the person lands somewhere new.
    if (open) router.push("/app/new");
    void changeThread(thread, { archived: true }).then(
      () =>
        toast.success("Specialist archived", {
          action: {
            label: "Undo",
            onClick: () =>
              void changeThread(thread, { archived: false }).catch(() =>
                toast.error("That specialist couldn’t be brought back. Try again."),
              ),
          },
        }),
      () => toast.error("That specialist couldn’t be archived. Try again."),
    );
  };
  const specialistRow = (place: (typeof places.specialists)[number]) => {
    const open = route.kind === "specialist" && route.id === place.specialist.id;
    return (
      <SpecialistRow
        key={place.specialist.id}
        place={place}
        active={open}
        folded={folded}
        onArchive={(thread) => archive(thread, open)}
      />
    );
  };

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

      <SectionLabel>Team</SectionLabel>
      <ul className="flex flex-col gap-px">
        <AuniRow chat={team.auni} route={route} folded={folded} />
        {team.active.map(specialistRow)}
      </ul>

      {team.retired.length + team.olderChats.length > 0 ? (
        <div inert={folded} className={FOLD_FADE}>
          <button
            type="button"
            aria-expanded={showHistory}
            onClick={() => setHistoryOpen(!showHistory)}
            className="group/history mt-5 mb-1 flex h-5 items-center gap-1 rounded-[6px] px-3 text-[12px] font-medium text-faint outline-none transition-colors duration-150 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            History
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-200 ease-settle motion-reduce:transition-none",
                showHistory && "rotate-90",
              )}
              strokeWidth={2}
            />
            {historyWaits && !showHistory ? (
              <span className="relative ml-0.5 size-2">
                <WaitingDot className="inset-0 size-2" />
                <span className="sr-only">, {ATTENTION_LABEL.waiting}</span>
              </span>
            ) : null}
          </button>
          {showHistory ? (
            <>
              <ul className="flex flex-col gap-px">
                {team.retired.map(specialistRow)}
                {shownChats.map(({ thread, status }) => (
                  <ChatRow
                    key={thread.id}
                    active={route.kind === "chat" && route.id === thread.id}
                    href={chatHref(thread.id)}
                    thread={thread}
                    status={status}
                  />
                ))}
              </ul>
              {(allChats ? team.olderChats.length > RECENT_CHATS : hiddenChats > 0) ? (
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
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Auni, first in the team: its latest open chat, the one it speaks up in, or a new one before
 * the first. Its line is that chat's title; a dot on it while something waits on the person or
 * an answer is unread, and the ring of its money while that moves.
 */
function AuniRow({
  chat,
  route,
  folded,
}: {
  readonly chat: ChatPlace | null;
  readonly route: PlaceRoute;
  readonly folded: boolean;
}) {
  const open = chat !== null && route.kind === "chat" && route.id === chat.thread.id;
  // The chat on screen points at nothing: what waits or came in there is in front of the person.
  const attention = chat && !open ? attentionOf(chat.thread) : null;
  const money = chat?.status.mark?.kind === "money" ? chat.status.mark : null;
  return (
    <li>
      <PlaceRow
        active={open}
        folded={folded}
        href={chat ? chatHref(chat.thread.id) : "/app/new"}
        thread={chat?.thread.id}
        mark={
          <>
            {/* Its art has room around it, so it overhangs the mark box to sit as large as an orb. */}
            <Mascot
              alt=""
              size={28}
              state={chat?.status.working ? "thinking" : "color"}
              className="max-w-none flex-none"
            />
            {attention ? (
              <WaitingDot attention={attention} className="-top-1 -right-1 size-2.5" />
            ) : null}
          </>
        }
        title="Auni"
        detail={
          chat ? (
            <span className={cn(chat.status.unread && "font-medium text-ink")}>
              {chat.thread.title}
            </span>
          ) : (
            "Ask me anything"
          )
        }
        status={attention ? ATTENTION_LABEL[attention] : undefined}
        trailing={money ? <ChatStatusMark mark={money} /> : null}
      />
    </li>
  );
}
