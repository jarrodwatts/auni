"use client";

import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { amountText, TONE_CLASS_NAME } from "@/components/activity/activity-groups";
import { useActivity } from "@/components/activity/use-activity";
import { liveWatches, useWatches } from "@/components/watching/use-watches";
import { WatchIcon } from "@/components/watching/watch-icon";
import { WatchSheet, WatchState } from "@/components/watching/watch-sheet";
import { shortDate } from "@/lib/dates";
import type { Specialist } from "@/lib/data/views";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";

/** Recent items the record shows before pointing to Activity. */
const RECORD_ITEMS = 5;

/** A pane section: a quiet name over what it holds, like the money pane's own groups. */
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-8 px-6">
      <h3 className="mb-2 text-[13px] font-medium text-faint">{title}</h3>
      {children}
    </section>
  );
}

/**
 * What Auni watches for it, each watch in a line with how it stands; any of them opens the
 * watch sheet, where they pause or go. Nothing shows while it watches nothing.
 */
export function PaneWatches({ specialist }: { readonly specialist: Specialist }) {
  const [open, setOpen] = useState(false);
  const scope = { specialistId: specialist.id };
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
              className="flex w-full items-center gap-3 rounded-[12px] px-2 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <WatchIcon watch={watch} />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[14.5px] leading-5",
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

/** Notes this long fold to a few lines until asked for. */
const LONG_NOTES = 280;

/** The specialist's own working notes, which it rewrites as it goes: a read, not a form. */
export function PaneNotes({ notes }: { readonly notes: string | null }) {
  const [all, setAll] = useState(false);
  if (!notes) return null;
  const long = notes.length > LONG_NOTES || notes.split("\n").length > 6;
  return (
    <Section title="Its notes">
      <p
        className={cn(
          "text-[14px] leading-[1.55] whitespace-pre-line text-ink-soft",
          long && !all && "line-clamp-6",
        )}
      >
        {notes}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="auni-text-link mt-1.5 text-[13px]"
        >
          {all ? "Show less" : "Show all"}
        </button>
      ) : null}
    </Section>
  );
}

/**
 * What it has done: the report it wrote when it retired, then its latest activity, each with
 * its amount, and the way to all of it in Activity.
 */
export function PaneRecord({ specialist }: { readonly specialist: Specialist }) {
  const activity = useActivity(specialist.id).data;
  const items = activity?.items ?? [];
  if (!activity && !specialist.report) return null;
  return (
    <Section title="Record">
      {specialist.report ? (
        <div className="mb-3 rounded-[16px] bg-foreground/[0.03] px-3.5 py-3">
          <p className="text-[12.5px] font-medium text-muted-foreground">
            {specialist.retiredAt
              ? `Its report, on retiring ${shortDate(specialist.retiredAt)}`
              : "Its report, on retiring"}
          </p>
          <p className="mt-1 text-[14px] leading-[1.5] whitespace-pre-line text-ink">
            {specialist.report}
          </p>
        </div>
      ) : null}
      {items.length > 0 ? (
        <>
          <ul className="divide-y divide-foreground/[0.05]">
            {items.slice(0, RECORD_ITEMS).map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] text-ink">{item.title}</span>
                  <span className="mt-0.5 block truncate text-[12.5px] text-faint">
                    {item.subtitle}
                  </span>
                </span>
                {item.amount ? (
                  <span
                    className={cn(
                      "flex-none text-[14.5px] font-semibold tabular-nums",
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
            href={`/app/activity?${new URLSearchParams({ specialist: specialist.id })}`}
            className="auni-text-link mt-2 inline-block text-[13px]"
          >
            All {specialist.name} activity
          </PlaceLink>
        </>
      ) : specialist.report ? null : (
        <p className="text-[14px] text-muted-foreground">Nothing has happened in it yet.</p>
      )}
    </Section>
  );
}
