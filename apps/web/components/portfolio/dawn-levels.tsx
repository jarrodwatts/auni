import { cn } from "@/lib/utils";

/**
 * A price the chart marks across its width, like where a position takes
 * profit, stops out or is wiped out. Its line sits under the chart's own, and
 * its label beside today, so the line stays the thing being read.
 */
export interface ChartLevel {
  readonly value: number;
  /** "Stop $790 · 7% away". */
  readonly label: string;
  readonly tone: "gain" | "loss" | "ruin";
  /** Drawn back, behind a level the price would reach first. */
  readonly faint?: boolean;
  /** A thread drops from today to it: the one the price would reach first. */
  readonly threaded?: boolean;
}

type PlacedLevel = ChartLevel & { readonly y: number };

const INK = { gain: "text-positive", loss: "text-negative", ruin: "text-negative" } as const;
/** Each tone's own colour let down into the page, and solid, so the chart's line never shows through a label. */
const WASH = {
  gain: "bg-[color-mix(in_oklab,var(--color-positive)_12%,var(--background))]",
  loss: "bg-[color-mix(in_oklab,var(--color-negative)_10%,var(--background))]",
  ruin: "bg-[color-mix(in_oklab,var(--color-negative)_18%,var(--background))]",
} as const;

/** How far apart labels sit, in pixels, so two close levels never overlap. */
const LABEL_GAP = 20;
/** Room between the labels and today's orb. */
const ORB_ROOM = 12;

/** The levels' lines, drawn before the chart's own line so it passes over them. */
export function LevelLines({
  levels,
  width,
  height,
}: {
  readonly levels: readonly PlacedLevel[];
  readonly width: number;
  readonly height: number;
}) {
  return (
    <svg aria-hidden width={width} height={height} className="absolute inset-0 overflow-visible">
      {levels.map((level) => (
        <line
          key={level.label}
          x1={0}
          x2={width}
          y1={level.y}
          y2={level.y}
          stroke="currentColor"
          strokeOpacity={level.faint ? 0.22 : 0.45}
          className={INK[level.tone]}
        />
      ))}
    </svg>
  );
}

/** Each level's label beside today, and the thread from today down (or up) to the nearest. */
export function LevelLabels({
  levels,
  today,
  width,
  height,
}: {
  readonly levels: readonly PlacedLevel[];
  readonly today: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
}) {
  const threaded = levels.find((level) => level.threaded);
  const tops = spread(
    levels.map((level) => level.y),
    LABEL_GAP,
  );
  return (
    <>
      {threaded ? (
        <svg
          aria-hidden
          width={width}
          height={height}
          className={cn("absolute inset-0 overflow-visible", INK[threaded.tone])}
        >
          <line
            x1={today.x}
            x2={today.x}
            y1={today.y + (threaded.y > today.y ? ORB_ROOM : -ORB_ROOM)}
            y2={threaded.y}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle
            cx={today.x}
            cy={threaded.y}
            r="3"
            fill="currentColor"
            stroke="var(--background)"
            strokeWidth="1.5"
          />
        </svg>
      ) : null}
      {levels.map((level, index) => (
        <span
          key={level.label}
          aria-hidden
          className={cn(
            "absolute -translate-y-1/2 rounded-full px-2 text-caption leading-[18px] font-semibold whitespace-nowrap ring-2 ring-background",
            INK[level.tone],
            WASH[level.tone],
            level.faint && "opacity-60",
          )}
          style={{ right: width - today.x + ORB_ROOM, top: tops[index] }}
        >
          {level.label}
        </span>
      ))}
    </>
  );
}

/** The heights, in their order, pushed apart where any two sit closer than `gap`. */
function spread(heights: readonly number[], gap: number): number[] {
  const order = heights.map((_, index) => index).toSorted((a, b) => heights[a]! - heights[b]!);
  const placed = [...heights];
  order.forEach((index, rank) => {
    const above = order[rank - 1];
    if (above !== undefined) placed[index] = Math.max(heights[index]!, placed[above]! + gap);
  });
  return placed;
}
