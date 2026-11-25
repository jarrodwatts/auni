"use client";

import type { ActivityItemWire, ThreadId } from "@auni/shared";
import { ReceiptText } from "lucide-react";
import { useState } from "react";

import { ThreadFailureNotice } from "@/components/app/thread-failure-notice";
import { PlaceHeader } from "@/components/places/place-header";
import { useMinute, usePlaces } from "@/components/places/use-places";
import { AuniSheet } from "@/components/ui/auni-sheet";
import type { Thread } from "@/lib/data/views";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import { activityGroups, amountText, TONE_CLASS_NAME } from "./activity-groups";
import { ActivityReceipt, ItemMark } from "./activity-receipt";
import { useActivity, useSeeActivity } from "./use-activity";

const READ_FAILURE = { message: "Your activity couldn't load.", action: "reload" } as const;

/**
 * What happened to their money: the list down the left, optionally filtered to
 * one thread, and the selected item's receipt on the right (or a sheet on
 * smaller screens).
 */
export function ActivityScreen({ initialOnly }: { readonly initialOnly: ThreadId | null }) {
  const [only, setOnly] = useState(initialOnly);
  const activity = useActivity(only);
  const fresh = useSeeActivity(activity.data);
  const { chats, archived } = usePlaces();
  const allThreads = [...chats, ...archived].map(({ thread }) => thread);
  const threadsById = new Map(allThreads.map((thread) => [thread.id, thread]));
  const filterThreads = allThreads.filter((thread) => thread.moveCount > 0 || thread.id === only);
  const wide = useMediaQuery("(min-width: 1280px)");
  const roomy = useMediaQuery("(min-width: 1024px)");
  const [picked, setPicked] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const items = activity.data?.items ?? [];
  const open = items.find(({ id }) => id === picked) ?? (wide ? items[0] : undefined);
  const threadOf = (item: ActivityItemWire) =>
    item.threadId ? threadsById.get(item.threadId) : undefined;
  const pick = (item: ActivityItemWire) => {
    setPicked(item.id);
    if (!wide) setSheetOpen(true);
  };

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col">
      <PlaceHeader
        root
        icon={<ReceiptText aria-hidden className="size-5 text-ink" strokeWidth={2} />}
        title="Activity"
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-4 pt-6 pb-16 sm:px-8">
            <h2 className="text-title text-ink max-sm:hidden">Activity</h2>
            <Chips
              threads={filterThreads}
              only={only}
              onChange={(next) => {
                setOnly(next);
                setPicked(null);
              }}
            />
            {activity.isError && !activity.data ? (
              <div className="mt-6">
                <ThreadFailureNotice
                  failure={READ_FAILURE}
                  onRetry={() => void activity.refetch()}
                />
              </div>
            ) : !activity.data ? (
              <ul className="auni-appear-late mt-6 flex flex-col gap-2">
                {[0, 1, 2, 3, 4].map((key) => (
                  <li key={key} className="h-16 rounded-card bg-surface" />
                ))}
              </ul>
            ) : items.length === 0 ? (
              <p className="py-16 text-center text-ui text-muted-foreground">
                {only
                  ? `Nothing has happened in ${threadsById.get(only)?.title ?? "this thread"} yet.`
                  : "Nothing has happened to your money yet."}
              </p>
            ) : (
              <ActivityList
                items={items}
                fresh={fresh}
                selected={wide ? open?.id : sheetOpen ? picked : null}
                onPick={pick}
              />
            )}
          </div>
        </div>
        {wide && open ? (
          <aside
            aria-label="Receipt"
            className="auni-scrollbar-none h-full w-[392px] flex-none overflow-y-auto border-l border-foreground/[0.07]"
          >
            <ActivityReceipt key={open.id} item={open} thread={threadOf(open)} />
          </aside>
        ) : null}
      </div>
      {open && !wide ? (
        <AuniSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          side={roomy ? "right" : "bottom"}
          title={open.title}
        >
          <div className="auni-scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            <ActivityReceipt item={open} thread={threadOf(open)} />
          </div>
        </AuniSheet>
      ) : null}
    </section>
  );
}

function Chips({
  threads,
  only,
  onChange,
}: {
  readonly threads: readonly Thread[];
  readonly only: ThreadId | null;
  readonly onChange: (only: ThreadId | null) => void;
}) {
  if (threads.length === 0) return null;
  const chip = (on: boolean) =>
    cn(
      "flex h-9 max-w-[220px] flex-none items-center gap-2 rounded-full border px-4 text-ui font-medium transition-colors",
      on
        ? "border-foreground bg-foreground text-background"
        : "border-foreground/[0.08] text-ink hover:bg-surface",
    );
  return (
    <div className="auni-scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:mt-4 sm:flex-wrap sm:px-0">
      <button
        type="button"
        aria-pressed={only === null}
        onClick={() => onChange(null)}
        className={chip(only === null)}
      >
        Everything
      </button>
      {threads.slice(0, 8).map((thread) => (
        <button
          key={thread.id}
          type="button"
          aria-pressed={only === thread.id}
          onClick={() => onChange(thread.id)}
          className={chip(only === thread.id)}
        >
          <span className="truncate">{thread.title}</span>
        </button>
      ))}
    </div>
  );
}

function ActivityList({
  items,
  fresh,
  selected,
  onPick,
}: {
  readonly items: readonly ActivityItemWire[];
  readonly fresh: ReadonlySet<string>;
  readonly selected: string | null | undefined;
  readonly onPick: (item: ActivityItemWire) => void;
}) {
  const now = useMinute();
  return activityGroups(items, now).map(({ label, items: rows }) => (
    <section key={label} aria-label={label}>
      <h3 className="mt-6 mb-1 text-meta font-medium text-faint">{label}</h3>
      <ul>
        {rows.map((item) => (
          <li key={item.id}>
            <Row
              item={item}
              fresh={fresh.has(item.id)}
              selected={item.id === selected}
              onPick={() => onPick(item)}
            />
          </li>
        ))}
      </ul>
    </section>
  ));
}

function Row({
  item,
  fresh,
  selected,
  onPick,
}: {
  readonly item: ActivityItemWire;
  readonly fresh: boolean;
  readonly selected: boolean;
  readonly onPick: () => void;
}) {
  const decision = item.kind === "outside" && item.decision;
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onPick}
      className={cn(
        "-mx-2.5 flex w-[calc(100%+20px)] items-center gap-3.5 rounded-card px-2.5 py-3 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/50",
        decision
          ? selected
            ? "bg-negative/[0.09]"
            : "bg-negative/[0.045] hover:bg-negative/[0.07]"
          : selected
            ? "bg-foreground/[0.05]"
            : "hover:bg-surface",
      )}
    >
      <span className="flex flex-none">
        <ItemMark item={item} size={40} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn("block truncate text-ui font-medium text-ink", fresh && "font-semibold")}
        >
          {fresh ? <span className="sr-only">New: </span> : null}
          {item.title}
        </span>
        <span className="mt-0.5 block truncate text-meta text-faint">{item.subtitle}</span>
      </span>
      {item.amount ? (
        <span className={cn("flex-none text-ui font-semibold", TONE_CLASS_NAME[item.amount.tone])}>
          {amountText(item.amount)}
        </span>
      ) : null}
    </button>
  );
}
