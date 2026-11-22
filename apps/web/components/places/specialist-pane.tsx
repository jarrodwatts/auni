"use client";

import { useEffect, useState } from "react";

import { Mascot } from "@/components/brand/mascot";
import { SpecialistOrb, orbHue } from "@/components/specialist/specialist-orb";
import { ActsDialog } from "@/components/specialist/manage/acts-dialog";
import { holdsNothing, useSpecialist } from "@/components/specialist/use-specialists";
import { BalanceChart } from "@/components/portfolio/balance-chart";
import { BigMoney } from "@/components/portfolio/big-money";
import { ChartChange } from "@/components/portfolio/chart-change";
import { RangePicker } from "@/components/portfolio/range-picker";
import { useChartWindow, useLiveEnd } from "@/components/portfolio/use-chart-window";
import { Skeleton } from "@/components/ui/skeleton";
import { shortDate } from "@/lib/dates";
import type { Specialist } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";

import { PaneHoldings } from "./pane-holdings";
import { PaneNotes, PaneRecord, PaneWatches } from "./pane-sections";
import { SpecialistFacts } from "./specialist-facts";

/** The chart grows into spare height between these; taller read as too much. */
const CHART_MIN = 150;
const CHART_MAX = 260;

/** Measures a box that may mount after data arrives, so it watches the node, not the first render. */
function useMeasuredHeight() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.round(entry?.contentRect.height ?? 0)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, height] as const;
}

/** Its kind, as the line over its purpose says it: "Take", "Role, retired Oct 3". */
function kindLine(specialist: Specialist): string {
  const kind = specialist.kind === "take" ? "Take" : "Role";
  if (specialist.status !== "retired") return kind;
  return specialist.retiredAt
    ? `${kind}, retired ${shortDate(specialist.retiredAt)}`
    : `${kind}, retired`;
}

/**
 * Everything about a specialist beside its chat, full height: its purpose and kind, how Auni
 * runs it and its pot, its money (the number, its line growing into the room the window leaves,
 * where the money sits, Auni's read on it), what it watches, its notes and its record. A view:
 * money moves and changes to its pot are asked for in its conversation.
 */
export function SpecialistPane({ specialistId }: { readonly specialistId: Specialist["id"] }) {
  const { specialist } = useSpecialist(specialistId);
  if (!specialist) return <PaneLoading />;
  return <SpecialistDetails key={specialist.id} specialist={specialist} />;
}

function SpecialistDetails({ specialist }: { readonly specialist: Specialist }) {
  const value = BigInt(specialist.value.baseUnits);
  const chart = useChartWindow(specialist.id, useLiveEnd(specialist.value, specialist.made));
  const [chartBox, chartHeight] = useMeasuredHeight();
  const [actsOpen, setActsOpen] = useState(false);
  const shown = chart.scrub?.baseUnits ?? value;
  const move = chart.move;
  const empty = holdsNothing(specialist);
  const retired = specialist.status === "retired";
  // Charted while any period is offered, so one drawn empty can be left for one that isn't.
  const charted = !empty && chart.ranges.length > 0;

  return (
    <div className="flex min-h-full flex-col pt-7">
      <div className="px-6">
        <p className="mb-1.5 pl-[30px] text-[12.5px] font-medium text-faint">
          {kindLine(specialist)}
        </p>
        {/* Room on the right for the laptop sheet's close button. */}
        <h2 className="flex items-start gap-2.5 text-[17px] lg:pr-8 leading-[1.35] font-semibold tracking-[-0.015em] text-ink">
          <SpecialistOrb
            specialist={specialist}
            size={20}
            className={retired ? "mt-[2px] flex-none opacity-45" : "mt-[2px] flex-none"}
          />
          {specialist.purpose}
        </h2>
        {retired ? null : (
          <div className="mt-3.5">
            <SpecialistFacts specialist={specialist} onActs={() => setActsOpen(true)} />
          </div>
        )}
        {empty ? (
          // Nothing in it: no $0 where the number will be.
          <p className="mt-6 text-[15px] text-muted-foreground">
            {retired ? "Nothing in it" : "No money in it yet"}
          </p>
        ) : (
          <BigMoney value={formatUsdcBalance(shown)} className="mt-5 text-[40px] sm:text-[40px]" />
        )}
        {charted && (move || chart.ranges.length > 1) ? (
          <div className="mt-1.5 flex items-center justify-between gap-3">
            {move ? <ChartChange move={move} label={chart.label} /> : null}
            <RangePicker
              ranges={chart.ranges}
              value={chart.range}
              onChange={chart.setRange}
              className="-mr-2 max-sm:hidden"
            />
          </div>
        ) : null}
      </div>

      {charted ? (
        <>
          {/* The line takes whatever height is left over, between a floor and a ceiling. */}
          <div
            ref={chartBox}
            className="mt-4 flex-1"
            style={{ minHeight: CHART_MIN, maxHeight: CHART_MAX }}
          >
            {chartHeight > 0 ? (
              <BalanceChart
                points={chart.points}
                label={`${specialist.name} value`}
                height={chartHeight}
                hue={orbHue(specialist.id)}
                onScrub={chart.setScrub}
              />
            ) : null}
          </div>
          <RangePicker
            ranges={chart.ranges}
            value={chart.range}
            onChange={chart.setRange}
            className="mt-3 px-4 sm:hidden"
          />
        </>
      ) : null}

      {specialist.holdings.length > 0 ? (
        <div className="mt-7 px-6">
          <PaneHoldings holdings={specialist.holdings} />
        </div>
      ) : null}

      {specialist.pulse ? (
        <p className="mx-6 mt-4 flex items-start gap-2.5 rounded-[16px] bg-foreground/[0.03] px-3.5 py-3 text-[13.5px] leading-[1.5] text-ink-soft">
          <Mascot alt="" size={18} state="color" className="mt-px flex-none" />
          {specialist.pulse}
        </p>
      ) : null}

      <PaneWatches specialist={specialist} />
      <PaneNotes notes={specialist.notes} />
      <PaneRecord specialist={specialist} />

      <div className="mt-auto pb-7" />
      {retired ? null : (
        <ActsDialog specialist={specialist} open={actsOpen} onOpenChange={setActsOpen} />
      )}
    </div>
  );
}

function PaneLoading() {
  return (
    <div className="auni-appear-late flex flex-col px-6 pt-7">
      <Skeleton className="h-5 w-56 rounded-md" />
      <Skeleton className="mt-3 h-9 w-52 rounded-full" />
      <Skeleton className="mt-5 h-10 w-44 rounded-lg" />
      <Skeleton className="mt-6 h-[180px] w-full rounded-card" />
      <Skeleton className="mt-7 h-1.5 w-full rounded-full" />
      <Skeleton className="mt-4 h-12 w-full rounded-card" />
      <Skeleton className="mt-2 h-12 w-full rounded-card" />
    </div>
  );
}
