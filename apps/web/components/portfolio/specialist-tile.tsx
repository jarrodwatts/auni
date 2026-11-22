"use client";

import { ArrowRight } from "lucide-react";
import { useMemo, type CSSProperties } from "react";

import { Mascot } from "@/components/brand/mascot";
import { SpecialistOrb, orbHue } from "@/components/specialist/specialist-orb";
import { Change } from "@/components/specialist/marks";
import { holdsNothing, useValueHistory } from "@/components/specialist/use-specialists";
import { PlaceLink } from "@/components/places/open-place";
import { WaitingDot } from "@/components/places/place-marks";
import { specialistHref } from "@/lib/app-links";
import type { Specialist } from "@/lib/data/views";
import { changePercent, formatUsdcBalance } from "@/lib/money";

import { BalanceChart } from "./balance-chart";
import { endingLive } from "./live-end";
import { useLiveEnd } from "./use-chart-window";

/**
 * Resting, a quiet fill; under the pointer it catches its orb's light:
 * the orb's wash fades in behind it and a soft shadow in that hue fades
 * up. Nothing moves until it's pressed.
 */
const TILE = [
  "group relative isolate flex min-w-0 flex-col rounded-[20px] bg-surface outline-none",
  "transition-[scale] duration-300 ease-settle active:scale-[0.985] active:duration-100 motion-reduce:transition-none motion-reduce:active:scale-100",
  "before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-linear-100 before:from-hue-wash before:to-surface before:to-72% before:opacity-0 before:transition-opacity before:duration-300 before:ease-settle",
  "after:absolute after:inset-0 after:-z-10 after:rounded-[inherit] after:shadow-[0_16px_32px_-20px] after:shadow-hue-shade after:opacity-0 after:transition-opacity after:duration-300 after:ease-settle",
  "hover:before:opacity-100 hover:after:opacity-100",
  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
].join(" ");

/** A specialist you open: its orb and name, its value, today's move and line, and Auni's read. */
export function SpecialistTile({
  specialist,
  waiting,
}: {
  readonly specialist: Specialist;
  readonly waiting: boolean;
}) {
  // Today's line, under today's move, both from the person's midnight, ending in its value.
  const today = useValueHistory(specialist.id, "Today").data;
  const live = useLiveEnd(specialist.value, specialist.made);
  const history = useMemo(() => endingLive(today?.points ?? [], live), [today, live]);
  const value = BigInt(specialist.value.baseUnits);
  const forming = holdsNothing(specialist);
  return (
    <PlaceLink
      href={specialistHref(specialist.id)}
      specialist={specialist.id}
      style={{ "--hue": orbHue(specialist.id).h } as CSSProperties}
      className={TILE}
    >
      <div className="flex items-center gap-2.5 px-4 pt-4">
        <span className="relative flex-none">
          <SpecialistOrb specialist={specialist} size={28} />
          {waiting ? <WaitingDot className="-top-0.5 -right-0.5" ring="ring-surface" /> : null}
        </span>
        <p className="min-w-0 flex-1 truncate text-ui text-ink">{specialist.name}</p>
      </div>
      {forming ? (
        // Taking shape: the belief stands where its value will be, never a $0.
        <p className="line-clamp-2 px-4 pt-2.5 text-ui leading-[1.35] font-normal text-muted-foreground">
          {specialist.purpose}
        </p>
      ) : (
        <div className="flex items-end gap-3 px-4 pt-2.5">
          <div className="flex-none">
            <p className="text-amount leading-none tracking-[-0.03em] text-ink tabular-nums">
              {formatUsdcBalance(value)}
            </p>
            <p className="mt-1.5 text-meta leading-4 font-medium">
              <Change
                pct={changePercent(BigInt(specialist.todayChangeBaseUnits), value)}
                period="today"
              />
            </p>
          </div>
          <BalanceChart
            points={history}
            label={`${specialist.name} value`}
            height={36}
            hue={orbHue(specialist.id)}
            className="ml-auto w-full max-w-24"
          />
        </div>
      )}
      <p className="mt-auto flex items-center gap-1.5 px-4 pt-3 pb-3.5 text-meta text-muted-foreground">
        {specialist.pulse ? (
          <>
            <Mascot alt="" size={13} state="color" className="flex-none" />
            <span className="truncate">{specialist.pulse}</span>
          </>
        ) : forming ? (
          <>
            <span className="truncate">Nothing in it yet</span>
            <ArrowRight
              aria-hidden
              className="ml-auto size-3.5 flex-none text-faint transition-colors duration-300 group-hover:text-muted-foreground"
              strokeWidth={2.2}
            />
          </>
        ) : null}
      </p>
    </PlaceLink>
  );
}
