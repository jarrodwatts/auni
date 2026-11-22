import { APP_LISTINGS } from "@auni/shared";
import Image from "next/image";

interface Mark {
  readonly src: string;
  readonly background: string;
  readonly ring: string;
  readonly fit: "contain" | "cover";
  /** How much of the tile's width the logo takes, 0 to 1. */
  readonly size: number;
  /**
   * The colour a glyph of Auni's own is drawn in. With it `src` is a shape, not a picture: one
   * colour on nothing, which takes this ink, so it reads on the tile in every look. A service's
   * logo has none: it keeps its own colours.
   */
  readonly ink?: string;
}

/** Whether a picture is one of Auni's own glyphs for a trade, which also stand where a logo would. */
export function isTradeGlyph(src: string): boolean {
  return src.startsWith("/brand/marks/");
}

/** The tile and the ink of a trade's glyph: a stock's candlesticks, a swap's arrows. */
const TRADE_GLYPH = {
  background: "var(--color-glyph-plate)",
  ring: "color-mix(in oklab, var(--foreground) 8%, transparent)",
  fit: "contain",
  size: 0.72,
  ink: "var(--color-glyph-ink)",
} as const satisfies Omit<Mark, "src">;

/** The tile and the ink of a glyph for a part of Auni itself, as its app's logo. */
const TOOL_GLYPH = {
  background: "var(--color-tool-plate)",
  ring: "color-mix(in oklab, var(--foreground) 8%, transparent)",
  fit: "contain",
  size: 1,
  ink: "var(--color-tool-ink)",
} as const satisfies Omit<Mark, "src">;

/** Auni's own marks, for cards no app's mark fits. */
const AUNI_MARKS = {
  // A neutral candlestick glyph, not a venue logo: nothing here may imply a brand endorsement
  // until a licensed mark is supplied.
  stocks: { src: "/brand/marks/stocks.svg", ...TRADE_GLYPH },
  // A neutral glyph of two arrows, worn by every EVM swap whichever route fills it: no one
  // service's logo, since none of them alone made the trade.
  swap: { src: "/brand/marks/swap.svg", ...TRADE_GLYPH },
  auni: {
    src: "/brand/auni-mascot-color.png",
    background: "var(--muted)",
    ring: "color-mix(in oklab, var(--foreground) 5%, transparent)",
    fit: "contain",
    size: 0.8,
  },
} as const satisfies Record<string, Mark>;

/** A logo whose app says no tile for it is the whole tile itself: it fills it, edge to edge. */
const WHOLE_TILE = {
  background: "var(--color-plate)",
  ring: "color-mix(in oklab, var(--foreground) 8%, transparent)",
  fit: "cover",
  size: 1,
} as const satisfies Omit<Mark, "src">;

const APP_MARKS: Readonly<Record<string, Mark>> = Object.fromEntries(
  APP_LISTINGS.flatMap(({ id, mark, logo, glyph }) =>
    logo ? [[id, { src: logo, ...(glyph ? TOOL_GLYPH : (mark ?? WHOLE_TILE)) }]] : [],
  ),
);

const MARKS: Readonly<Record<string, Mark>> = { ...APP_MARKS, ...AUNI_MARKS };

/**
 * How an app's own logo sits when it is drawn in a round frame instead of on its tile (a holding
 * it keeps, in a list of holdings): set in as far as its tile sets it in, so a logo drawn to its
 * own edge isn't cut by the circle: the share of the frame's width left clear on each side. Null
 * for any other picture, and for a logo that fills its tile.
 */
export function logoInset(src: string): number | null {
  const mark = Object.values(APP_MARKS).find((one) => one.src === src);
  return mark?.fit === "contain" && !mark.ink ? (1 - mark.size) / 2 : null;
}

/** Whether `id` (an app's, or one of Auni's own) has a mark of its own to draw. */
export function hasMark(id: string): boolean {
  return Object.hasOwn(MARKS, id);
}

/** A logo on its own tile, filling the slot it's drawn in: an app's, or one of Auni's own. */
export function IntegrationMark({
  integration,
  size,
}: {
  readonly integration: string;
  readonly size: number;
}) {
  // A card kept in a conversation can name a mark this build no longer has (its app removed).
  const mark: Mark = MARKS[integration] ?? AUNI_MARKS.auni;
  const share = `${mark.size * 100}%`;
  return (
    <span
      aria-hidden
      className="relative flex shrink-0 items-center justify-center overflow-hidden"
      data-slot="integration-mark"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: mark.background,
        boxShadow: `inset 0 0 0 1px ${mark.ring}, 0 0 0 1px var(--color-mark-line)`,
      }}
    >
      {mark.ink ? (
        <Glyph ink={mark.ink} share={share} src={mark.src} />
      ) : (
        <Image
          alt=""
          height={80}
          loading="eager"
          src={mark.src}
          style={{ width: share, height: share, objectFit: mark.fit }}
          unoptimized
          width={80}
        />
      )}
    </span>
  );
}

/** A glyph's shape, filled with an ink: the picture is only where the ink shows. */
function Glyph({
  ink,
  share,
  src,
}: {
  readonly ink: string;
  readonly share: string;
  readonly src: string;
}) {
  return (
    <span
      style={{
        width: share,
        height: share,
        background: ink,
        mask: `url(${src}) center / contain no-repeat`,
      }}
    />
  );
}

/** A trade's glyph in a round frame, where a logo would be: on the look's own plate, in its ink. */
export function TradeGlyph({ src, size }: { readonly src: string; readonly size: number }) {
  return (
    <span
      aria-hidden
      className="relative inline-flex flex-none items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: TRADE_GLYPH.background,
        boxShadow: `inset 0 0 0 1px ${TRADE_GLYPH.ring}`,
      }}
    >
      <Glyph ink={TRADE_GLYPH.ink} share="100%" src={src} />
    </span>
  );
}
