import {
  ChartLine,
  Coins,
  Globe,
  Leaf,
  Microchip,
  Pill,
  Sparkles,
  Zap,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import type { CSSProperties } from "react";

import type { Specialist } from "@/lib/data/views";
import { cn } from "@/lib/utils";

/** Lucide has no tennis ball, so this one is drawn on lucide's own grid to stay in the family. */
function TennisBall({ size = 24, strokeWidth = 2, fillOpacity, style }: LucideProps) {
  return (
    <svg
      aria-hidden
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity={fillOpacity ?? 0} />
      <path d="M5 4.8a10 10 0 0 1 0 14.4" />
      <path d="M19 4.8a10 10 0 0 0 0 14.4" />
    </svg>
  );
}

/** Keep in step with core's SPECIALIST_THEMES, the set the agent picks from. */
const GLYPHS: Readonly<Record<string, LucideIcon | typeof TennisBall>> = {
  pill: Pill,
  tennis: TennisBall,
  chip: Microchip,
  bolt: Zap,
  leaf: Leaf,
  globe: Globe,
  coin: Coins,
  chart: ChartLine,
};

/** The hue each specialist's orb may be, in degrees, with how vivid its lines are drawn. */
const ORB_HUES = [
  { h: 253, s: 88 },
  { h: 20, s: 73 },
  { h: 206, s: 60 },
  { h: 173, s: 64 },
  { h: 337, s: 72 },
  { h: 225, s: 81 },
] as const;

/** FNV-1a over the id: the same specialist always grows the same orb. */
function seed(id: string): number {
  let hash = 0x811c9dc5;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The orb's own hue, for anything drawn in its color (its chart line, its tint). */
export function orbHue(id: string): { readonly h: number; readonly s: number } {
  return ORB_HUES[seed(id) % ORB_HUES.length] ?? ORB_HUES[0];
}

/**
 * Its hue (bg-hue-mark) lit the way the mascot is: one soft highlight up on its left and a little
 * shade low on its right, so it reads as a body with weight, never a flat status dot. Its blob
 * shape is grown from the id.
 */
function orbStyle(id: string): CSSProperties {
  const n = seed(id);
  const r = (shift: number) => Math.round(44 + (((n >>> shift) & 0xff) / 255) * 14);
  return {
    "--hue": orbHue(id).h,
    backgroundImage:
      "radial-gradient(circle at 34% 28%, color-mix(in oklab, var(--color-plate) 62%, transparent) 0, transparent 46%)",
    boxShadow: "inset -1.5px -2px 4px var(--color-hue-shade)",
    borderRadius: `${r(0)}% ${100 - r(0)}% ${r(8)}% ${100 - r(8)}% / ${r(16)}% ${r(24)}% ${100 - r(24)}% ${100 - r(16)}%`,
  } as CSSProperties;
}

/**
 * A specialist's identity at any size: its lit blob, with its glyph on it (all but the smallest,
 * 16px and under, where `glyph` can still ask for it), so a new one is never a bare dot.
 */
export function SpecialistOrb({
  specialist,
  size = 16,
  glyph = size >= 18,
  className,
}: {
  readonly specialist: Pick<Specialist, "id" | "theme">;
  readonly size?: number;
  readonly glyph?: boolean;
  readonly className?: string;
}) {
  const Glyph = GLYPHS[specialist.theme] ?? Sparkles;
  return (
    <span
      aria-hidden
      className={cn("inline-flex flex-none items-center justify-center bg-hue-mark", className)}
      style={{ width: size, height: size, ...orbStyle(specialist.id) }}
    >
      {glyph ? (
        <Glyph
          aria-hidden
          fill="currentColor"
          fillOpacity={0.28}
          size={Math.round(size * (size < 30 ? 0.6 : 0.56))}
          strokeWidth={size < 30 ? 2.3 : 2.1}
          style={{ color: "var(--color-plate)" }}
        />
      ) : null}
    </span>
  );
}
