"use client";

import { useState, type ReactNode } from "react";

import { AssetLogo } from "@/components/specialist/marks";
import type { Holding, LooseHoldings } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";

import { HoldingMove } from "./money-rows";
import { OtherTokensDialog, OtherTokensMark } from "./other-tokens";
import { otherTokensLabel } from "./other-tokens-text";

/** Money outside every specialist: cash first, then anything bought on its own, each tile the same shape. */
export function CashTiles({
  loose,
  className,
}: {
  readonly loose: LooseHoldings;
  readonly className?: string;
}) {
  return (
    <ul className={className}>
      <li>
        <CashTile holding={loose.cash} name="Cash" detail={null} />
      </li>
      {loose.other.map((holding) => (
        <li key={holding.id}>
          <CashTile
            holding={holding}
            name={holding.name}
            detail={<HoldingMove holding={holding} />}
          />
        </li>
      ))}
      {loose.otherTokens > 0 ? (
        <li>
          <OtherTokensTile count={loose.otherTokens} />
        </li>
      ) : null}
    </ul>
  );
}

/** Tokens Auni doesn't count, as the last tile, which opens them (see OtherTokensDialog). */
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

function CashTile({
  holding,
  name,
  detail,
}: {
  readonly holding: Holding;
  readonly name: string;
  readonly detail: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[16px] bg-surface px-3.5 py-3">
      <AssetLogo holding={holding} size={30} className="flex-none" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-meta text-muted-foreground">{name}</p>
        <p className="mt-0.5 flex items-baseline justify-between gap-2 leading-5 tabular-nums">
          <span className="text-ui font-semibold tracking-[-0.01em] text-ink">
            {formatUsdcBalance(BigInt(holding.value.baseUnits))}
          </span>
          {detail ? (
            <span className="truncate text-caption font-normal text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
