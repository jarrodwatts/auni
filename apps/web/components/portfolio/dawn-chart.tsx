"use client";

import "./dawn-chart.css";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";

import { cn } from "@/lib/utils";

import { LevelLabels, LevelLines, type ChartLevel } from "./dawn-levels";
import { Moments, type ChartMoment, type Spot } from "./dawn-moments";
import { COMPACT_WIDTH, noteAir } from "./dawn-notes";

/**
 * Auni's line: thin, in the place's own color, on nothing: no field, no axes, no grid. Today is
 * a dot at its end. Dragging across it reports the
 * reading under the finger. Levels, when given, mark prices across it (see
 * dawn-levels). Moments, when given, sit on the line as beads
 * (see dawn-moments).
 */

export interface ChartHue {
  readonly h: number;
  readonly s: number;
}

/** Auni blue, the mascot's color: Portfolio and anything that is all your money. */
export const AUNI_HUE: ChartHue = { h: 226, s: 78 };

/** One reading: when (any increasing number, like epoch ms) and how much. */
interface DawnPoint {
  readonly at: number;
  readonly value: number;
}

/** Room on the right, in pixels, so today's orb never clips at the edge. */
const END_ROOM = 16;
/** The line's band, as shares of the height: air above it, and a field with body beneath. */
const TOP = 0.12;
const BOTTOM = 0.24;
/** With notes written in the sky, the line sits lower, on less of a field. */
const NOTED_BOTTOM = 0.1;
/** Room kept on the left, in pixels, so a bead at the very start shows whole. */
const START_ROOM = 5;
/** The least the chart's height stands for, as a share of the value: cents never fill it. */
const MIN_SPAN = 0.01;
/** One reading per this many pixels: the line keeps its shape, not noise a screen can't show. */
const READING_PITCH = 14;
/** What the line is drawn in: the chart says only its hue (`--hue`), dawn-chart.css the rest. */
const LINE = "var(--dawn-line)";

/**
 * The slope at each reading of a monotone cubic through them all (Steffen's
 * method, as d3's curveMonotoneX): rounded, and never swinging past a reading
 * the way a looser curve overshoots after a sharp drop.
 */
function slopes(xs: readonly number[], ys: readonly number[]): number[] {
  const secants = xs.slice(1).map((x, i) => (ys[i + 1]! - ys[i]!) / (x - xs[i]! || 1));
  const tangents = xs.map((x, i) => {
    const before = secants[i - 1];
    const after = secants[i];
    if (before === undefined || after === undefined) return 0;
    if (before * after <= 0) return 0;
    const run = xs[i + 1]! - xs[i - 1]!;
    const blend = (before * (xs[i + 1]! - x) + after * (x - xs[i - 1]!)) / run;
    return Math.sign(before) * Math.min(2 * Math.abs(before), 2 * Math.abs(after), Math.abs(blend));
  });
  // The ends lean on their one neighbor, as d3 does.
  const last = xs.length - 1;
  tangents[0] = (3 * secants[0]! - tangents[1]!) / 2;
  tangents[last] = (3 * secants[last - 1]! - tangents[last - 1]!) / 2;
  return tangents;
}

function smoothPath(
  xs: readonly number[],
  ys: readonly number[],
  tangents: readonly number[],
): string {
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const third = (xs[i + 1]! - xs[i]!) / 3;
    d += `C${xs[i]! + third},${ys[i]! + tangents[i]! * third} ${xs[i + 1]! - third},${ys[i + 1]! - tangents[i + 1]! * third} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}

/**
 * The line's height at x, on the curve smoothPath draws. Its control points
 * sit at thirds across each span, so x runs evenly along a span and only
 * the height needs the cubic.
 */
function heightAt(
  xs: readonly number[],
  ys: readonly number[],
  tangents: readonly number[],
  x: number,
): number {
  const after = xs.findIndex((reading) => reading >= x);
  if (after <= 0) return after === 0 ? ys[0]! : ys.at(-1)!;
  const i = after - 1;
  const run = xs[after]! - xs[i]!;
  const t = run ? (x - xs[i]!) / run : 0;
  const u = 1 - t;
  const lift = ys[i]! + (tangents[i]! * run) / 3;
  const settle = ys[after]! - (tangents[after]! * run) / 3;
  return (
    u * u * u * ys[i]! + 3 * u * u * t * lift + 3 * u * t * t * settle + t * t * t * ys[after]!
  );
}

export function DawnChart({
  points,
  height,
  hue = AUNI_HUE,
  label,
  onScrub,
  drawIn = false,
  moments,
  levels,
  className,
}: {
  /** Readings in order, oldest first, placed along the line by when they were taken; any number. */
  readonly points: readonly DawnPoint[];
  readonly height: number;
  readonly hue?: ChartHue;
  /** Read aloud in place of the drawing. */
  readonly label: string;
  /** The index into `points` nearest the pointer, or null when it leaves. A chart you can scrub breathes at today. */
  readonly onScrub?: (index: number | null) => void;
  /** Sweeps the line in from the left as it first appears, then lights today. */
  readonly drawIn?: boolean;
  /** Things that happened, each a bead on the line at its time; the chart becomes a group you can explore. */
  readonly moments?: readonly ChartMoment[];
  /** Prices marked across the chart, which its height always takes in. */
  readonly levels?: readonly ChartLevel[];
  readonly className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Drawn in real pixels, so the dots stay round at any width.
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const compact = width < COMPACT_WIDTH;
  const notes = Math.min(moments?.filter((moment) => moment.note).length ?? 0, 2);

  const geometry = useMemo(() => {
    const first = points[0];
    const latest = points.at(-1);
    if (!first || !latest || points.length < 2 || width <= END_ROOM) return null;
    const duration = latest.at - first.at || 1;
    const across = (at: number) => ((at - first.at) / duration) * (width - END_ROOM);
    const x = (point: DawnPoint) => across(point.at);
    // The first reading, where the period's change is measured from, then the
    // last reading in each few pixels, so today is always drawn.
    const drawn = [0];
    let slice = 0;
    points.forEach((point, index) => {
      if (index === 0) return;
      const next = Math.ceil(x(point) / READING_PITCH);
      if (next === slice && drawn.length > 1) drawn[drawn.length - 1] = index;
      else drawn.push(index);
      slice = next;
    });
    const values = drawn.map((index) => points[index]!.value);
    const marked = levels?.map((level) => level.value) ?? [];
    const min = Math.min(...values, ...marked);
    const max = Math.max(...values, ...marked);
    // Movement fills the band, but a sliver of change is never stretched
    // into drama, and a flat line rests in the middle.
    const span = Math.max(max - min, Math.abs(max) * MIN_SPAN) || 1;
    const floor = (max + min) / 2 - span / 2;
    // Notes keep their rows of sky clear above the line.
    const top = Math.max(height * TOP, noteAir(notes, compact));
    const band = height - top - height * (notes ? NOTED_BOTTOM : BOTTOM);
    const xs = drawn.map((index) => x(points[index]!));
    const yOf = (value: number) => top + (1 - (value - floor) / span) * band;
    const ys = values.map(yOf);
    const tangents = slopes(xs, ys);
    const line = smoothPath(xs, ys, tangents);
    const end = xs.at(-1)!;
    const spots: Spot[] = (moments ?? []).map((moment) => {
      const at = Math.min(Math.max(across(moment.at), START_ROOM), end);
      return { moment, x: at, y: heightAt(xs, ys, tangents, at) };
    });
    const placed = (levels ?? []).map((level) => ({ ...level, y: yOf(level.value) }));
    return {
      drawn,
      xs,
      ys,
      line,
      spots,
      placed,
    };
  }, [points, height, width, moments, levels, notes, compact]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!onScrub || !geometry) return;
    // On a bead or its note, the story is what's being read, not the line under it.
    if (
      event.target instanceof Element &&
      event.target.closest("[data-moment], [data-moment-note]")
    ) {
      leave();
      return;
    }
    const { xs } = geometry;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    // The reading nearest the finger in time, so the orb rests on the line.
    const after = xs.findIndex((reading) => reading >= x);
    const index =
      after === -1
        ? xs.length - 1
        : after > 0 && x - xs[after - 1]! < xs[after]! - x
          ? after - 1
          : after;
    setScrub(index);
    onScrub(geometry.drawn[index]!);
  };
  const leave = () => {
    if (!onScrub) return;
    setScrub(null);
    onScrub(null);
  };

  return (
    <div
      ref={box}
      role={moments?.length ? "group" : "img"}
      aria-label={label}
      data-draw-in={drawIn || undefined}
      // Only a chart you can scrub keeps the finger; any other lets the page scroll.
      className={cn("auni-dawn relative select-none", onScrub && "touch-none", className)}
      style={{ height, "--hue": hue.h } as CSSProperties}
      onPointerMove={move}
      onPointerLeave={leave}
    >
      {geometry?.placed.length ? (
        <LevelLines levels={geometry.placed} width={width} height={height} />
      ) : null}
      {geometry ? (
        <Drawing
          geometry={geometry}
          width={width}
          height={height}
          at={scrub ?? geometry.xs.length - 1}
          scrubbing={scrub !== null}
        />
      ) : null}
      {geometry?.placed.length ? (
        <LevelLabels
          levels={geometry.placed}
          today={{ x: geometry.xs.at(-1)!, y: geometry.ys.at(-1)! }}
          width={width}
          height={height}
        />
      ) : null}
      {geometry?.spots.length ? (
        <Moments spots={geometry.spots} width={width} compact={compact} />
      ) : null}
    </div>
  );
}

function Drawing({
  geometry: { xs, ys, line },
  width,
  height,
  at,
  scrubbing,
}: {
  readonly geometry: {
    readonly xs: readonly number[];
    readonly ys: readonly number[];
    readonly line: string;
  };
  readonly width: number;
  readonly height: number;
  readonly at: number;
  readonly scrubbing: boolean;
}) {
  const place: CSSProperties = { left: xs[at], top: ys[at] };
  return (
    <>
      <svg aria-hidden width={width} height={height} className="absolute inset-0 overflow-visible">
        <path
          d={line}
          fill="none"
          stroke={LINE}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {scrubbing ? (
        <span
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-foreground/[0.08]"
          style={{ left: place.left }}
        />
      ) : null}
      {/* Today: drawn last when the line sweeps in. */}
      <span aria-hidden className="auni-dawn-today pointer-events-none absolute inset-0">
        <span
          className="auni-dawn-orb absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-background transition-[left,top] duration-150 ease-settle motion-reduce:transition-none"
          style={{ ...place, background: LINE }}
        />
      </span>
    </>
  );
}
