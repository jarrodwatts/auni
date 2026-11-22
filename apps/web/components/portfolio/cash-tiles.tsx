"use client";

import { useState, type ReactNode } from "react";

import { AssetLogo } from "@/components/brand/marks";
import type { Holding } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";

import { HoldingMove } from "./money-rows";
import { OtherTokensDialog, OtherTokensMark } from "./other-tokens";
import { otherTokensLabel } from "./other-tokens-text";

/** Holdings grid on wide screens: one clean tile per live position. */
export function HoldingTiles({
  holdings,
  className,
}: {
  readonly holdings: readonly Holding[];
  readonly className?: string;
}) {
  return (
    <ul className={className}>
      {holdings.map((holding) => (
        <li key={holding.id}>
          <MoneyTile
            holding={holding}
            name={holding.name}
            subtitle={holding.detail}
            detail={<HoldingMove holding={holding} />}
          />
        </li>
      ))}
    </ul>
  );
}

/** Cash and uncounted tokens on wide screens. */
export function CashTiles({
  cash,
  otherTokens,
  className,
}: {
  readonly cash: Holding;
  readonly otherTokens: number;
  readonly className?: string;
}) {
  return (
    <ul className={className}>
      <li>
        <MoneyTile holding={cash} name="Cash" subtitle="Ready to use" detail={null} />
      </li>
      {otherTokens > 0 ? (
        <li>
          <OtherTokensTile count={otherTokens} />
        </li>
      ) : null}
    </ul>
  );
}

function OtherTokensTile({ count }: { readonly count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full min-w-0 items-center gap-3 rounded-[16px] bg-surface px-3.5 py-3 text-left transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] focus-visible:outline-none"
      >
        <OtherTokensMark size={30} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-meta text-muted-foreground">{otherTokensLabel(count)}</p>
          <p className="mt-0.5 truncate text-ui leading-5 font-semibold text-ink">Not counted</p>
        </div>
      </button>
      <OtherTokensDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function MoneyTile({
  holding,
  name,
  subtitle,
  detail,
}: {
  readonly holding: Holding;
  readonly name: string;
  readonly subtitle: string;
  readonly detail: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[16px] bg-surface px-3.5 py-3">
      <AssetLogo holding={holding} size={34} className="flex-none" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-medium text-ink">{name}</p>
        <p className="mt-0.5 flex items-baseline justify-between gap-2 leading-5 tabular-nums">
          <span className="text-ui font-semibold tracking-[-0.01em] text-ink">
            {formatUsdcBalance(BigInt(holding.value.baseUnits))}
          </span>
          {detail ? (
            <span className="truncate text-caption font-normal text-muted-foreground">{detail}</span>
          ) : (
            <span className="truncate text-caption font-normal text-muted-foreground">
              {subtitle}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
