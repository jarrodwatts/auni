"use client";

import { useState } from "react";

import { useBrandColors } from "@/components/specialist/brand-colors";
import { AssetLogo, Change } from "@/components/specialist/marks";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Holding } from "@/lib/data/views";
import { changePercent, formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";

function share(holding: Holding, total: bigint): number {
  return total > 0n ? Number((BigInt(holding.value.baseUnits) * 1000n) / total) / 10 : 0;
}

/**
 * A holding's color, eased toward white so the strip reads as proportion,
 * not as the loudest thing on the page. Core reads the colors from each
 * logo; one it couldn't read in time is read here instead.
 */
function useHoldingTint(holding: Holding): string {
  const colors = useBrandColors(holding.logoUrl);
  if (!colors) return "var(--border)";
  const soft = (color: string) => `color-mix(in oklab, ${color} 62%, var(--background))`;
  return colors.from === colors.to
    ? soft(colors.from)
    : `linear-gradient(90deg, ${soft(colors.from)}, ${soft(colors.to)})`;
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
        {/* The hit area is taller than the strip, so a 6px line is easy to land on. */}
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

/**
 * Where the money sits: a quiet proportion strip, each holding in its own
 * softened color. Under the pointer a segment names itself and the rest step back.
 */
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

/** The strip over one row per holding. */
export function PaneHoldings({ holdings }: { readonly holdings: readonly Holding[] }) {
  const total = holdings.reduce((sum, holding) => sum + BigInt(holding.value.baseUnits), 0n);
  return (
    <>
      <BrandBar holdings={holdings} />
      <ul className="mt-2 divide-y divide-foreground/[0.05]">
        {holdings.map((holding) => (
          <HoldingRow key={holding.id} holding={holding} total={total} />
        ))}
      </ul>
    </>
  );
}

/** One holding: its logo, its name and share keyed to the strip, its value and today's move. */
function HoldingRow({ holding, total }: { readonly holding: Holding; readonly total: bigint }) {
  const tint = useHoldingTint(holding);
  const value = BigInt(holding.value.baseUnits);
  const change =
    holding.todayChangeBaseUnits === null ? null : BigInt(holding.todayChangeBaseUnits);
  return (
    <li className="flex h-16 items-center gap-3">
      <AssetLogo holding={holding} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium text-ink">{holding.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground tabular-nums">
          <span
            aria-hidden
            className="size-1.5 flex-none rounded-full"
            style={{ background: tint }}
          />
          {share(holding, total).toFixed(0)}%
        </p>
      </div>
      <div className="flex-none text-right">
        <p className="text-[15px] font-semibold text-ink tabular-nums">
          {formatUsdcBalance(value)}
        </p>
        {/* Nothing when core had no price history for it. */}
        {change === null ? null : (
          <Change
            pct={changePercent(change, value)}
            period="today"
            className="mt-0.5 block text-[13px] font-medium"
          />
        )}
      </div>
    </li>
  );
}
