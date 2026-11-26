import { servableImage } from "@auni/shared";
import { Coins } from "lucide-react";
import Image, { getImageProps } from "next/image";
import { useState, type ReactNode } from "react";

import { isTradeGlyph, logoInset, TradeGlyph } from "@/components/integrations/integration-mark";
import type { Holding } from "@/lib/data/views";
import { formatPercentChange } from "@/lib/money";
import { cn } from "@/lib/utils";

const CIRCLE =
  "relative inline-flex flex-none items-center justify-center overflow-hidden rounded-full bg-plate after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:ring-1 after:ring-foreground/[0.08] after:ring-inset";

/** A logo is drawn at twice its size, so it stays sharp on a phone's screen. */
const logoPixels = (size: number) => size * 2;

/**
 * Fetches the logo LogoImage would draw at `size`, through the same optimizer address, so it
 * shows at once when it's drawn. Nothing for artwork LogoImage wouldn't load either.
 */
export function preloadLogo(src: string, size: number): void {
  if (!servableImage(src) || isTradeGlyph(src)) return;
  const pixels = logoPixels(size);
  const { props } = getImageProps({ alt: "", src, width: pixels, height: pixels });
  const image = new window.Image();
  if (props.srcSet) image.srcset = props.srcSet;
  image.src = props.src;
}

/**
 * A logo in a circle, every one under the same hairline so white, red and
 * cyan marks sit as one family. Artwork the optimizer can't serve, or that
 * fails to load, shows `fallback` instead.
 */
export function LogoImage({
  src,
  size,
  fallback,
  className,
}: {
  readonly src: string | null;
  readonly size: number;
  readonly fallback: ReactNode;
  readonly className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src || !servableImage(src)) return fallback;
  // A glyph of Auni's own is no logo, so it takes no logo's white plate.
  if (isTradeGlyph(src)) return <TradeGlyph size={size} src={src} />;
  const inset = logoInset(src);
  return (
    <span
      className={cn(CIRCLE, className)}
      // In pixels: a share given as a percentage would be of the row the mark sits in.
      style={{ width: size, height: size, ...(inset ? { padding: size * inset } : {}) }}
    >
      {/* Through the optimizer: the page's CSP admits only same-origin images. */}
      <Image
        alt=""
        className={cn(
          "size-full",
          inset ? "object-contain" : "object-cover",
          // xStocks artwork is a tilted square whose dark corners peek past the circle.
          src.includes("xstocks-metadata") && "scale-[1.22]",
        )}
        height={logoPixels(size)}
        onError={() => setFailed(src)}
        src={src}
        width={logoPixels(size)}
      />
    </span>
  );
}

/**
 * What stands where a logo would when there is none: a neutral coin, the same for every such
 * thing, so the name or ticker beside it does the naming. Never initials, which read as a brand.
 */
export function NoMark({
  size,
  className,
}: {
  readonly size: number;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full bg-glyph-plate text-glyph-ink ring-1 ring-mark-line ring-inset",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Coins style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={1.75} />
    </span>
  );
}

/** A holding's logo; without one it can serve, a neutral coin. */
export function AssetLogo({
  holding,
  size = 40,
  className,
}: {
  readonly holding: Pick<Holding, "logoUrl">;
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <LogoImage
      src={holding.logoUrl}
      size={size}
      fallback={<NoMark size={size} className={className} />}
      className={className}
    />
  );
}

/** The direction a move went, as the small filled caret money apps use. */
function MoveCaret({ down }: { readonly down: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 6"
      className={cn("mr-1 inline-block h-[0.4em] w-[0.55em] align-[0.12em]", down && "rotate-180")}
    >
      <path d="M4 0 8 6H0z" fill="currentColor" />
    </svg>
  );
}

/**
 * A move as colored text behind a caret ("▲ 1.8%"). The period it covers is
 * spoken and shown on hover rather than printed, so rows stay as quiet as a
 * brokerage list while no move goes unlabelled.
 */
export function Change({
  pct,
  period,
  className,
}: {
  readonly pct: number;
  readonly period: string;
  readonly className?: string;
}) {
  const text = formatPercentChange(pct);
  const up = text.startsWith("+");
  const down = text.startsWith("−");
  return (
    <span
      title={`${text} ${period}`}
      className={cn(
        "whitespace-nowrap tabular-nums",
        up ? "text-positive" : down ? "text-negative" : "text-muted-foreground",
        className,
      )}
    >
      {up || down ? <MoveCaret down={down} /> : null}
      <span className="sr-only">{up ? "up " : down ? "down " : ""}</span>
      {up || down ? text.slice(1) : text}
      <span className="sr-only"> {period}</span>
    </span>
  );
}
