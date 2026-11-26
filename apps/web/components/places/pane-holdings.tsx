"use client";

import { useState } from "react";

import { useBrandColors } from "@/components/brand/brand-colors";
import { AssetLogo, Change } from "@/components/brand/marks";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Holding } from "@/lib/data/views";
import { changePercent, formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";

function share(holding: Holding, total: bigint): number {
  return total > 0n ? Number((BigInt(holding.value.baseUnits) * 1000n) / total) / 10 : 0;
}

function useHoldingTint(holding: Holding): string {
  const colors = useBrandColors(holding.logoUrl);
  if (!colors) return "var(--border)";
  // The logo's own colour, solid: a holding's colour comes from its mark, never a gradient.
  return `color-mix(in oklab, ${colors.from} 62%, var(--background))`;
}

function Segment({
  holding,
  width,
  dimmed,
  onHover,
}: {
  readonly holding: Holding;
  readonly width: number;
  readonly dimmed: boolean;
  readonly onHover: (id: string | null) => void;
}) {
  const tint = useHoldingTint(holding);
  return (
    <Tooltip onOpenChange={(open) => onHover(open ? holding.id : null)}>
      <TooltipTrigger asChild>
        <span
          className="flex h-full cursor-default items-center py-2"
          style={{ width: `${width}%` }}
        >
          <span
            className={cn(
              "h-1.5 w-full rounded-full transition-opacity duration-200",
              dimmed && "opacity-35",
            )}
            style={{ background: tint }}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={2}>
        {holding.name}
        <span className="ml-2 text-background/60 tabular-nums">{width.toFixed(0)}%</span>
      </TooltipContent>
    </Tooltip>
  );
}

function BrandBar({ holdings }: { readonly holdings: readonly Holding[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = holdings.reduce((sum, holding) => sum + BigInt(holding.value.baseUnits), 0n);
  if (total === 0n) return null;
  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={300}>
      <div aria-hidden className="-my-2 flex h-[22px] w-full gap-[3px]">
        {holdings.map((holding) => (
          <Segment
            key={holding.id}
            holding={holding}
            width={share(holding, total)}
            dimmed={hovered !== null && hovered !== holding.id}
            onHover={setHovered}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}

/** One row per position this take holds, under a bar of how it splits when there's more than one. */
export function PaneHoldings({ holdings }: { readonly holdings: readonly Holding[] }) {
  return (
    <>
      {holdings.length > 1 ? <BrandBar holdings={holdings} /> : null}
      <ul className="mt-1 divide-y divide-border">
        {holdings.map((holding) => (
          <HoldingRow key={holding.id} holding={holding} />
        ))}
      </ul>
    </>
  );
}

function HoldingRow({ holding }: { readonly holding: Holding }) {
  const value = BigInt(holding.value.baseUnits);
  const change =
    holding.todayChangeBaseUnits === null ? null : BigInt(holding.todayChangeBaseUnits);
  return (
    <li className="flex h-16 items-center gap-3">
      <AssetLogo holding={holding} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-ink">{holding.name}</p>
        {holding.detail ? (
          <p className="mt-0.5 truncate text-meta text-muted-foreground">{holding.detail}</p>
        ) : null}
      </div>
      <div className="flex-none text-right">
        <p className="text-body font-semibold text-ink tabular-nums">{formatUsdcBalance(value)}</p>
        {change === null ? null : (
          <Change
            pct={changePercent(change, value)}
            period="today"
            className="mt-0.5 block text-meta font-medium tabular-nums lining-nums"
          />
        )}
      </div>
    </li>
  );
}
