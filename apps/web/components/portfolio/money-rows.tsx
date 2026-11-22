"use client";

import { useState, type ReactNode } from "react";

import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { AssetLogo, Change, MoveCaret } from "@/components/specialist/marks";
import { holdsNothing } from "@/components/specialist/use-specialists";
import { PlaceLink } from "@/components/places/open-place";
import { WaitingDot } from "@/components/places/place-marks";
import type { SpecialistPlace } from "@/components/places/use-places";
import { specialistHref } from "@/lib/app-links";
import type { Specialist, Holding, LooseHoldings } from "@/lib/data/views";
import { changePercent, formatUsdcBalance, formatUsdcChange } from "@/lib/money";
import { cn } from "@/lib/utils";

import { OtherTokensDialog, OtherTokensMark } from "./other-tokens";
import { otherTokensLabel } from "./other-tokens-text";

/**
 * On a phone, Portfolio's money is one list of rows, like a bank's: each
 * specialist, then cash and anything held on its own, so
 * the rows add up to the total above them. Rows sit on the page's fill with
 * a hairline between them that starts where the words do.
 */
const LIST = "overflow-hidden rounded-[20px] bg-surface";
const ROW =
  "flex items-center pl-4 outline-none transition-colors duration-150 active:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04]";
const RULE = "group-[:not(:first-child)]/row:border-t border-foreground/[0.06]";

export function SpecialistRows({ places }: { readonly places: readonly SpecialistPlace[] }) {
  return (
    <ul className={LIST}>
      {places.map(({ specialist, waiting }) => (
        <SpecialistRow key={specialist.id} specialist={specialist} waiting={waiting} />
      ))}
    </ul>
  );
}

function SpecialistRow({
  specialist,
  waiting,
}: {
  readonly specialist: Specialist;
  readonly waiting: boolean;
}) {
  const forming = holdsNothing(specialist);
  const value = BigInt(specialist.value.baseUnits);
  return (
    <li className="group/row">
      <PlaceLink href={specialistHref(specialist.id)} specialist={specialist.id} className={ROW}>
        <Row
          mark={
            <>
              <SpecialistOrb specialist={specialist} size={36} />
              {waiting ? <WaitingDot className="-top-px -right-px" ring="ring-surface" /> : null}
            </>
          }
          name={specialist.name}
          value={forming ? null : formatUsdcBalance(value)}
          // Taking shape: no value yet rather than a $0.
          note={forming ? "Nothing in it yet" : (specialist.pulse ?? specialist.purpose)}
          move={
            forming ? null : (
              <Change
                pct={changePercent(BigInt(specialist.todayChangeBaseUnits), value)}
                period="today"
                className="font-medium"
              />
            )
          }
        />
      </PlaceLink>
    </li>
  );
}

/** Money outside every specialist: cash first, then anything bought on its own, each row the same shape. */
export function LooseRows({ loose }: { readonly loose: LooseHoldings }) {
  return (
    <ul className={LIST}>
      <li className="group/row">
        <div className={ROW}>
          <Row
            mark={<AssetLogo holding={loose.cash} size={36} />}
            name="Cash"
            value={formatUsdcBalance(BigInt(loose.cash.value.baseUnits))}
            note="Ready for Auni to put to work"
            move={null}
          />
        </div>
      </li>
      {loose.other.map((holding) => (
        <li key={holding.id} className="group/row">
          <div className={ROW}>
            <Row
              mark={<AssetLogo holding={holding} size={36} />}
              name={holding.name}
              value={formatUsdcBalance(BigInt(holding.value.baseUnits))}
              note={holding.detail}
              move={<HoldingMove holding={holding} />}
            />
          </div>
        </li>
      ))}
      {loose.otherTokens > 0 ? <OtherTokensRow count={loose.otherTokens} /> : null}
    </ul>
  );
}

/** Tokens Auni doesn't count, as the last row, which opens them (see OtherTokensDialog). */
function OtherTokensRow({ count }: { readonly count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="group/row">
      <button type="button" className={cn(ROW, "w-full text-left")} onClick={() => setOpen(true)}>
        <Row
          mark={<OtherTokensMark size={36} />}
          name={otherTokensLabel(count)}
          value={null}
          note="Not counted until you add one"
          move={null}
        />
      </button>
      <OtherTokensDialog open={open} onOpenChange={setOpen} />
    </li>
  );
}

/** Mark on the left; name over a quiet note, value over today's move. */
function Row({
  mark,
  name,
  value,
  note,
  move,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly value: string | null;
  readonly note: string;
  readonly move: ReactNode;
}) {
  return (
    <>
      <span className="relative flex flex-none">{mark}</span>
      <span className={cn("ml-3 flex min-h-16 min-w-0 flex-1 flex-col justify-center pr-4", RULE)}>
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-reading leading-[22px] font-medium text-ink">
            {name}
          </span>
          {value ? (
            <span className="flex-none text-reading leading-[22px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
              {value}
            </span>
          ) : null}
        </span>
        <span className="flex items-baseline gap-3 text-meta">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{note}</span>
          {move ? <span className="flex-none tabular-nums">{move}</span> : null}
        </span>
      </span>
    </>
  );
}

/** A holding's move today in dollars behind its caret; nothing when there's none to show. */
export function HoldingMove({ holding }: { readonly holding: Holding }) {
  if (holding.todayChangeBaseUnits === null) return null;
  const change = formatUsdcChange(BigInt(holding.todayChangeBaseUnits));
  if (change.startsWith("$")) return null;
  const down = !change.startsWith("+");
  return (
    <span
      title={`${change} today`}
      className={cn("whitespace-nowrap font-medium", down ? "text-negative" : "text-positive")}
    >
      <MoveCaret down={down} />
      <span className="sr-only">{down ? "down " : "up "}</span>
      {change.slice(1)}
      <span className="sr-only"> today</span>
    </span>
  );
}
