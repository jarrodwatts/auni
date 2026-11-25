"use client";

import { Popover } from "radix-ui";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import { noteRows, placeNotes, type PlacedNote } from "./dawn-notes";

/**
 * Moments on a Dawn line: a bead where each happened, tinted by which way it
 * went, at most two of them written on the chart beside a hairline, and a
 * quiet card over any bead that is pointed at, tapped or focused.
 */

export type MomentTone = "positive" | "negative" | "neutral";

/** Two lines written above a bead: what it was, and what came of it. */
export interface MomentNote {
  readonly title: string;
  readonly line: string;
  readonly lineTone: "positive" | "negative" | "faint";
}

export interface ChartMoment {
  readonly key: string;
  /** When it happened, on the same clock as the chart's readings. */
  readonly at: number;
  readonly tone: MomentTone;
  /** What a screen reader hears for its bead. */
  readonly label: string;
  /** Written on the chart; only the first two moments that carry one are. */
  readonly note?: MomentNote;
  /** What opens over the bead. */
  readonly detail: ReactNode;
}

/** A bead's color, by which way its moment went. */
export const MOMENT_COLOR: Record<MomentTone, string> = {
  positive: "var(--color-positive)",
  negative: "var(--color-negative)",
  neutral: "var(--color-faint)",
};

/** A note's second line, colored by what came of it. */
export const NOTE_LINE_TONE: Record<MomentNote["lineTone"], string> = {
  positive: "text-positive",
  negative: "text-negative",
  faint: "text-faint",
};

/** Time to cross from a bead to its card before a hover card closes. */
const HOVER_GRACE_MS = 140;
/** A noted bead's halo, which its hairline starts just above. */
const HALO = 7.5;

/**
 * Which moment's card is open, shared by every bead so one opens at a time.
 * Hover and keyboard focus preview it; a tap or click pins it until tapped
 * again or dismissed. Pinned from the keyboard, focus moves into it so its
 * links are reachable, and Escape brings focus back.
 */
export function useMomentCards() {
  const [open, setOpen] = useState<{ readonly key: string; readonly pinned: boolean } | null>(null);
  const timer = useRef<number>(undefined);
  const content = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const handingBack = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hold = () => window.clearTimeout(timer.current);
  return {
    open,
    content,
    hold,
    show(key: string) {
      hold();
      setOpen((current) => (current?.key === key ? current : { key, pinned: false }));
    },
    hideSoon() {
      hold();
      timer.current = window.setTimeout(
        () => setOpen((current) => (current?.pinned ? current : null)),
        HOVER_GRACE_MS,
      );
    },
    toggle(key: string, fromKeyboard: boolean) {
      hold();
      returnFocus.current = fromKeyboard;
      setOpen((current) => (current?.key === key && current.pinned ? null : { key, pinned: true }));
      if (fromKeyboard) requestAnimationFrame(() => content.current?.focus());
    },
    close(key: string) {
      setOpen((current) => (current?.key === key ? null : current));
    },
    /** As a card closes: only one the keyboard opened hands focus back to its bead; a hover card never took it. */
    handBackFocus(event: Event) {
      if (returnFocus.current) {
        // Radix focuses the bead straight after this, which mustn't preview the card Escape just closed.
        handingBack.current = true;
        requestAnimationFrame(() => (handingBack.current = false));
      } else {
        event.preventDefault();
      }
      returnFocus.current = false;
    },
    /** Whether this focus is the bead getting it back from its card. */
    handedBack() {
      return handingBack.current;
    },
  };
}

type MomentCards = ReturnType<typeof useMomentCards>;

/** A button that opens a moment's card: a bead on the line, or a row where there is no line. */
export function MomentTrigger({
  moment,
  cards,
  className,
  style,
  children,
}: {
  readonly moment: ChartMoment;
  readonly cards: MomentCards;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children: ReactNode;
}) {
  const { key } = moment;
  const isOpen = cards.open?.key === key;
  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) cards.close(key);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={moment.label}
          data-moment={key}
          data-open={isOpen || undefined}
          className={className}
          style={style}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") cards.show(key);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") cards.hideSoon();
          }}
          onFocus={(event) => {
            // Tabbing previews it; a click or tap pins it instead.
            if (event.currentTarget.matches(":focus-visible") && !cards.handedBack())
              cards.show(key);
          }}
          onBlur={() => cards.hideSoon()}
          onClick={(event) => {
            event.preventDefault();
            cards.toggle(key, event.detail === 0);
          }}
        >
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={isOpen ? cards.content : undefined}
          aria-label={moment.label}
          side="top"
          sideOffset={10}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={cards.handBackFocus}
          onPointerDownOutside={(event) => {
            // Its note on the chart opens it too, so tapping the note isn't tapping away.
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(`[data-moment-note="${CSS.escape(key)}"]`)) event.preventDefault();
          }}
          onPointerEnter={cards.hold}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") cards.hideSoon();
          }}
          className="z-50 w-[288px] max-w-[calc(100vw-24px)] origin-(--radix-popover-content-transform-origin) rounded-card bg-popover px-3.5 pt-3 pb-3.5 text-left text-ink border border-border shadow-float outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none"
        >
          {moment.detail}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export interface Spot {
  readonly moment: ChartMoment;
  readonly x: number;
  readonly y: number;
}

/** The beads and notes over a drawn line, placed by the chart. */
export function Moments({
  spots,
  width,
  compact,
}: {
  /** Kept the same between renders unless the moments or the line change. */
  readonly spots: readonly Spot[];
  readonly width: number;
  readonly compact: boolean;
}) {
  const cards = useMomentCards();
  const noted = useMemo(() => spots.filter(({ moment }) => moment.note).slice(0, 2), [spots]);
  const { placed, ghost } = useNotePlaces(noted, width, compact);
  const written = new Set(
    noted.filter((_, index) => placed[index]).map(({ moment }) => moment.key),
  );
  return (
    <>
      {noted.map((spot, index) => (
        <Note
          key={spot.moment.key}
          spot={spot}
          place={placed[index] ?? null}
          ghost={ghost(spot.moment.key)}
          compact={compact}
          cards={cards}
        />
      ))}
      {spots.map(({ moment, x, y }) => {
        const big = written.has(moment.key);
        const color = MOMENT_COLOR[moment.tone];
        return (
          <MomentTrigger
            key={moment.key}
            moment={moment}
            cards={cards}
            className="group absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-[7px] focus-visible:outline-ring"
            style={{ left: x, top: y }}
          >
            {big ? (
              <span
                aria-hidden
                className="absolute rounded-full opacity-[0.16]"
                style={{ width: HALO * 2, height: HALO * 2, background: color }}
              />
            ) : null}
            <span
              aria-hidden
              className={cn(
                "relative rounded-full transition-transform duration-200 ease-settle group-hover:scale-[1.35] group-data-[open]:scale-[1.35] motion-reduce:transition-none",
                big ? "size-[7.2px]" : "size-[5.2px]",
              )}
              style={{
                background: color,
                boxShadow: `0 0 0 ${big ? 1.6 : 1.3}px var(--background)`,
              }}
            />
          </MomentTrigger>
        );
      })}
    </>
  );
}

/**
 * Where the notes go, from how wide their words really are: each is drawn
 * once unseen at its natural width, measured, then placed.
 */
function useNotePlaces(noted: readonly Spot[], width: number, compact: boolean) {
  const [placed, setPlaced] = useState<readonly (PlacedNote | null)[]>([]);
  const ghosts = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const spots = noted.map(({ moment, x }) => ({
      x,
      width: Math.ceil(ghosts.current.get(moment.key)?.offsetWidth ?? 0),
    }));
    setPlaced(placeNotes(spots, width, compact));
  }, [noted, width, compact]);
  return {
    placed,
    ghost: (key: string) => (element: HTMLElement | null) => {
      if (element) ghosts.current.set(key, element);
      else ghosts.current.delete(key);
    },
  };
}

function Note({
  spot: { moment, x, y },
  place,
  ghost,
  compact,
  cards,
}: {
  readonly spot: Spot;
  readonly place: PlacedNote | null;
  readonly ghost: (element: HTMLElement | null) => void;
  readonly compact: boolean;
  readonly cards: MomentCards;
}) {
  const note = moment.note!;
  const { block } = noteRows(compact);
  const words = (
    <>
      <span
        className={cn(
          "block truncate font-semibold tracking-[-0.01em] text-ink",
          compact ? "text-caption leading-[15px]" : "text-meta leading-4",
        )}
      >
        {note.title}
      </span>
      <span
        className={cn(
          "block truncate",
          compact ? "text-caption leading-[14px]" : "text-caption leading-[15px]",
          NOTE_LINE_TONE[note.lineTone],
        )}
      >
        {note.line}
      </span>
    </>
  );
  return (
    <>
      {/* Drawn unseen at its natural width, to measure. */}
      <span
        ref={ghost}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 w-max"
      >
        {words}
      </span>
      {place ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute w-px bg-ink/[0.16]"
            style={{
              left: x - 0.5,
              top: place.top + 2,
              height: Math.max(y - HALO - place.top - 2, 0),
            }}
          />
          {/* The bead's own button is what a screen reader reaches; the note opens the same card. */}
          <span
            aria-hidden
            data-moment-note={moment.key}
            className={cn("absolute cursor-pointer", place.side === "left" && "text-right")}
            style={{ left: place.left, top: place.top, width: place.width, height: block }}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") cards.show(moment.key);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") cards.hideSoon();
            }}
            onClick={() => cards.toggle(moment.key, false)}
          >
            {words}
          </span>
        </>
      ) : null}
    </>
  );
}
