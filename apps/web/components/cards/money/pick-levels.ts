import type { PickDetailWire } from "@auni/shared";

import type { ChartLevel } from "@/components/portfolio/dawn-levels";
import { formatAssetPrice, trimCents } from "@/lib/money";

const LEVEL = {
  take_profit: { name: "Take profit", tone: "gain" },
  stop: { name: "Stop", tone: "loss" },
  liquidation: { name: "Wiped out", tone: "ruin" },
} as const;

/**
 * A position's prices as its chart marks them. The thread runs to the first
 * one a losing move reaches, and says how far it is. The stop and wipe-out
 * both sit on the losing side, so that's whichever is nearer today; when it's
 * the stop, it sells before wipe-out can happen, and wipe-out draws back.
 */
export function chartLevels(levels: PickDetailWire["levels"], now: number): ChartLevel[] {
  const first = levels
    .filter(({ kind }) => kind !== "take_profit")
    .toSorted((a, b) => Math.abs(a.price - now) - Math.abs(b.price - now))[0];
  return levels.map((level) => {
    const threaded = level === first;
    const away = Math.round(Math.abs(level.price / now - 1) * 100);
    return {
      value: level.price,
      label: `${LEVEL[level.kind].name} ${trimCents(formatAssetPrice(level.price))}${
        threaded ? `, ${away < 1 ? "under 1%" : `${away}%`} away` : ""
      }`,
      tone: LEVEL[level.kind].tone,
      faint: level.kind === "liquidation" && first?.kind === "stop",
      threaded,
    };
  });
}
