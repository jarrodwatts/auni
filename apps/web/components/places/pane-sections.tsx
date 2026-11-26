"use client";

import type { ThreadId } from "@auni/shared";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { amountText, TONE_CLASS_NAME } from "@/components/activity/activity-groups";
import { useActivity } from "@/components/activity/use-activity";
import { liveWatches, useWatches } from "@/components/watching/use-watches";
import { WatchIcon } from "@/components/watching/watch-icon";
import { WatchSheet, WatchState } from "@/components/watching/watch-sheet";
import type { Thread } from "@/lib/data/views";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";

/** Recent items the record shows before pointing to Activity. */
const RECORD_ITEMS = 5;

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-7 px-6">
      <h3 className="mb-2 text-meta font-medium text-faint">{title}</h3>
      {children}
    </section>
  );
}

/**
 * What Auni watches for this thread, each watch in a line with how it stands; any of them opens
 * the watch sheet, where they pause or go. Nothing shows while it watches nothing.
 */
export function PaneWatches({ threadId }: { readonly threadId: ThreadId }) {
  const [open, setOpen] = useState(false);
  const scope = { threadId };
  const watches = liveWatches(useWatches(scope).data ?? []);
  if (watches.length === 0) return null;
  return (
    <Section title="Watching">
      <ul className="-mx-2">
        {watches.map((watch) => (
          <li key={watch.id}>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
              className="flex w-full items-center gap-3 rounded-control px-2 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <WatchIcon watch={watch} />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-ui leading-5",
                    watch.status === "active" ? "text-ink" : "text-muted-foreground",
                  )}
                >
                  {watch.description}
                </span>
                <WatchState watch={watch} />
              </span>
              <ChevronRight aria-hidden className="size-3.5 flex-none text-faint" />
            </button>
          </li>
        ))}
      </ul>
      <WatchSheet scope={scope} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

const LONG_NOTES = 280;

/** Working notes Auni keeps for this thread. */
export function PaneNotes({ notes }: { readonly notes: string | null }) {
  const [all, setAll] = useState(false);
  if (!notes) return null;
  const long = notes.length > LONG_NOTES || notes.split("\n").length > 6;
  return (
    <Section title="Notes">
      <p
        className={cn(
          "text-ui leading-[1.55] whitespace-pre-line text-ink-soft",
          long && !all && "line-clamp-6",
        )}
      >
        {notes}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="auni-text-link mt-1.5 text-meta"
        >
          {all ? "Show less" : "Show all"}
        </button>
      ) : null}
    </Section>
  );
}

/** Recent money activity opened in this thread, with a link to all of it in Activity. */
export function PaneRecord({ thread }: { readonly thread: Thread }) {
  const activity = useActivity(thread.id).data;
  const items = activity?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Section title="Activity">
      <ul className="divide-y divide-foreground/[0.05]">
        {items.slice(0, RECORD_ITEMS).map((item) => (
          <li key={item.id} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui text-ink">{item.title}</span>
              <span className="mt-0.5 block truncate text-caption text-faint">{item.subtitle}</span>
            </span>
            {item.amount ? (
              <span
                className={cn(
                  "flex-none text-ui font-semibold tabular-nums",
                  TONE_CLASS_NAME[item.amount.tone],
                )}
              >
                {amountText(item.amount)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <PlaceLink
        href={`/app/activity?${new URLSearchParams({ thread: thread.id })}`}
        className="auni-text-link mt-2 inline-block text-meta"
      >
        All thread activity
      </PlaceLink>
    </Section>
  );
}
