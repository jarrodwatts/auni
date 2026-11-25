"use client";

import type { ActivityItemWire, ActivityWire } from "@auni/shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";

import { activityGroups, amountText, TONE_CLASS_NAME } from "@/components/activity/activity-groups";
import { ItemMark } from "@/components/activity/activity-receipt";
import { useSeeActivity } from "@/components/activity/use-activity";
import { useMinute } from "@/components/places/use-places";
import { buttonVariants } from "@/components/ui/button";
import { ChoicePills } from "@/components/ui/choice-pills";
import { Row } from "@/components/ui/row";
import { Eyebrow, Section } from "@/components/ui/section";
import { cn } from "@/lib/utils";

import { RECENT_FILTERS, recentOf, type RecentFilter } from "./money-groups";

/** How many moves show before the owner asks for more, and how many more each time. */
const PAGE = 10;

/**
 * Every move, newest first, under the week or month it happened in, each opening its receipt;
 * narrowed to trades, or to money in and out, by the pills at its head.
 */
export function Recent({
  activity,
  onOpen,
}: {
  readonly activity: UseQueryResult<ActivityWire>;
  readonly onOpen: (item: ActivityItemWire) => void;
}) {
  const [filter, setFilter] = useState<RecentFilter>("all");
  const [count, setCount] = useState(PAGE);
  const fresh = useSeeActivity(activity.data);
  const now = useMinute();
  const all = activity.data?.items ?? [];
  const items = recentOf(all, filter);
  return (
    <Section
      heading="Recent"
      aria-label="Recent"
      action={
        all.length > 0 ? (
          <ChoicePills
            label="Show"
            options={RECENT_FILTERS}
            value={filter}
            onChange={(next) => {
              setFilter(next);
              setCount(PAGE);
            }}
          />
        ) : null
      }
    >
      {activity.isError && !activity.data ? (
        <p className="text-ui text-muted-foreground">
          Couldn&apos;t load your recent moves. Your money is untouched. Reload to try again.
        </p>
      ) : !activity.data ? (
        <ul className="auni-appear-late flex flex-col gap-2">
          {[0, 1, 2].map((key) => (
            <li key={key} className="h-14 rounded-card bg-surface" />
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          {filter === "all"
            ? "No moves yet. Every trade, deposit, and withdrawal you allow will appear here as a receipt."
            : filter === "trades"
              ? "No trades yet."
              : "No deposits or withdrawals yet."}
        </p>
      ) : (
        <>
          {activityGroups(items.slice(0, count), now).map(({ label, items: rows }) => (
            <section key={label} aria-label={label} className="not-first:mt-4">
              <Eyebrow className="mb-1">{label}</Eyebrow>
              <ul>
                {rows.map((item) => (
                  <li key={item.id}>
                    <RecentRow item={item} fresh={fresh.has(item.id)} onOpen={() => onOpen(item)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {items.length > count ? (
            <button
              type="button"
              onClick={() => setCount(count + PAGE * 2)}
              className={buttonVariants({ variant: "ghost", size: "sm", className: "mt-2 -ml-3" })}
            >
              Show more
            </button>
          ) : null}
        </>
      )}
    </Section>
  );
}

function RecentRow({
  item,
  fresh,
  onOpen,
}: {
  readonly item: ActivityItemWire;
  readonly fresh: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <Row
      asChild
      mark={<ItemMark item={item} size={36} />}
      title={
        <span className={cn(fresh && "font-semibold")}>
          {fresh ? <span className="sr-only">New: </span> : null}
          {item.title}
        </span>
      }
      meta={item.subtitle}
      end={
        item.amount ? (
          <span className={cn("font-medium", TONE_CLASS_NAME[item.amount.tone])}>
            {amountText(item.amount)}
          </span>
        ) : null
      }
    >
      <button type="button" onClick={onOpen} />
    </Row>
  );
}
