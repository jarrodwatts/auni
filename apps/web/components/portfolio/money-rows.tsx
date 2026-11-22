"use client";

import { useState, type ReactNode } from "react";

import { AssetLogo, MoveCaret } from "@/components/brand/marks";
import type { Holding } from "@/lib/data/views";
import { formatUsdcBalance, formatUsdcChange } from "@/lib/money";
import { cn } from "@/lib/utils";

import { OtherTokensDialog, OtherTokensMark } from "./other-tokens";
import { otherTokensLabel } from "./other-tokens-text";

const LIST = "overflow-hidden rounded-[20px] bg-surface";
const ROW =
  "flex items-center pl-4 outline-none transition-colors duration-150 active:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04]";
const RULE = "group-[:not(:first-child)]/row:border-t border-foreground/[0.06]";

/** Live non-cash holdings as a clean brokerage-style list. */
export function HoldingRows({ holdings }: { readonly holdings: readonly Holding[] }) {
  return (
    <ul className={LIST}>
      {holdings.map((holding) => (
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
    </ul>
  );
}

/** Cash and uncounted wallet tokens on mobile. */
export function CashRows({
  cash,
  otherTokens,
}: {
  readonly cash: Holding;
  readonly otherTokens: number;
}) {
  return (
    <ul className={LIST}>
      <li className="group/row">
        <div className={ROW}>
          <Row
            mark={<AssetLogo holding={cash} size={36} />}
            name="Cash"
            value={formatUsdcBalance(BigInt(cash.value.baseUnits))}
            note="Ready for Auni to put to work"
            move={null}
          />
        </div>
      </li>
      {otherTokens > 0 ? <OtherTokensRow count={otherTokens} /> : null}
    </ul>
  );
}

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
