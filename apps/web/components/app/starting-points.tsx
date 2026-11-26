"use client";

import { appListing, STARTING_POINTS, type FactSource } from "@auni/shared";
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { requestComposerFocus } from "@/components/app/composer";
import { useMoney } from "@/components/money/money-provider";
import { LogoImage, preloadLogo } from "@/components/brand/marks";
import { useFirstRun } from "@/components/first-run/use-first-run";
import { useMe } from "@/components/personalization/use-me";
import { useStartingPoints, useStartingPointsKept } from "@/lib/data/starting-points";
import tightMascot from "@/public/brand/auni-mascot-tight.png";

/** A point's picture, whether a coin, a market's own or Auni's mascot. */
const PICTURE = 20;
/** The row's own left inset, so its picture's left edge sits on the composer's placeholder. */
const INSET = 20;
/** From the picture to the words. */
const GAP = 14;
/** Where a row's words start, from the row's left edge. */
export const WORDS_START = INSET + PICTURE + GAP;
/**
 * The rows' widths of words while they're written: as many rows as come (STARTING_POINTS), so
 * nothing on the page moves when they arrive.
 */
const WAITING_WIDTHS = [212, 176, 238, 194].slice(0, STARTING_POINTS);

// Each point is a bare row, no box: its picture, then one line of what's true (in ink) and what
// to do (lighter). The picture's left edge sits on the composer's placeholder text, and the
// words start a fixed GAP after it. Rows are 52 tall with nothing between them, so the evenness
// comes from the rhythm. Under a pointer a row lightens and an arrow says it picks those words.
const ROW = "group/point flex h-[52px] w-full items-center rounded-card pr-3 text-left";
const ROW_SPACING = { paddingLeft: INSET, gap: GAP } as const;

/**
 * Ways into a new chat, drawn from what Auni sees of the owner (core's starting points), each
 * wearing a picture of what it's about. Picking one puts its words in the box (pickStartingPoint).
 */
export function StartingPoints() {
  const { points, observedAt, waiting } = useStartingPoints();
  const { portfolio } = useMoney();
  const me = useMe();
  const { addMoneyHref, settingsHref } = useAppDialogs();
  // First run asks only for the take: money and signals come after it.
  const firstRun = useFirstRun();
  const needsSignals = !firstRun && !me.xHandle && me.watchedWallets.length === 0;

  return (
    <div className="w-full">
      {waiting ? (
        <div aria-busy aria-label="Finding places to start">
          {WAITING_WIDTHS.map((width, index) => (
            <div
              key={width}
              className={`${ROW} auni-loading-row`}
              style={{ ...ROW_SPACING, animationDelay: `${index * 70}ms` }}
            >
              <span className="auni-loading-sheen size-5 flex-none rounded-full" />
              <span className="auni-loading-sheen h-3 max-w-full rounded-full" style={{ width }} />
            </div>
          ))}
        </div>
      ) : (
        <ul>
          {points.map((point, index) => (
            <li
              key={`${point.statement} ${point.action}`}
              className="auni-stagger-in"
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <button
                type="button"
                onClick={() => pickStartingPoint(point)}
                style={ROW_SPACING}
                className={`${ROW} text-body tracking-[-0.01em] transition-colors sm:text-reading duration-150 hover:bg-foreground/[0.04] focus-ring-inset`}
              >
                {/* 15px on a phone, PHONE_TEXT_PX, which core measures each line at (lineFits). */}
                <PointImage image={point.image} />
                <span className="flex min-w-0 flex-1 flex-col">
                  {/* Should a line still run long, what's true shortens; what to do never does. */}
                  <span className="flex min-w-0 items-baseline gap-[0.25em]">
                    <span className="min-w-0 truncate text-ink">{point.statement}</span>
                    <span className="flex-none whitespace-nowrap text-muted-foreground">
                      {point.action}
                    </span>
                  </span>
                  {/* What a claim about the markets rests on, before it becomes the owner's words. */}
                  {seenOn(point.sources, observedAt) && (
                    <span className="truncate text-caption text-faint">
                      {seenOn(point.sources, observedAt)}
                    </span>
                  )}
                </span>
                <ArrowRight
                  aria-hidden
                  className="ml-2 size-4 flex-none text-faint opacity-0 transition-[opacity,translate] duration-200 ease-settle group-hover/point:translate-x-0.5 group-hover/point:opacity-100 group-focus-visible/point:opacity-100 motion-reduce:transition-none max-sm:hidden"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Always one line tall: their money is read after the page draws, and a line arriving
          then would push the page, which is centred, up by half of it. */}
      <p
        className="mt-2 flex h-5 items-center pr-2 text-meta text-muted-foreground"
        style={{ paddingLeft: WORDS_START }}
      >
        {portfolio?.empty && !firstRun ? (
          <span className="auni-stagger-in truncate">
            Your balance is $0.{" "}
            <Link
              href={addMoneyHref}
              scroll={false}
              className="font-medium text-primary transition-opacity hover:opacity-75"
            >
              Add money
            </Link>
          </span>
        ) : needsSignals ? (
          <Link
            href={settingsHref("personalization")}
            scroll={false}
            className="truncate transition-colors hover:text-ink"
          >
            Personalize ideas with your X handle or wallet
          </Link>
        ) : null}
      </p>
    </div>
  );
}

/**
 * A point picked, by click, tap or key alike: its words take the new chat's box, focused with the
 * caret at their end, for the owner to read, change, then send. A point's words carry more than
 * its line says (what Auni is asked to do), so none is ever sent unseen.
 */
export function pickStartingPoint(point: { readonly prompt: string }): void {
  requestComposerFocus("new", point.prompt, true);
}

/**
 * Keeps the starting points read wherever the app is open, and their pictures fetched, so a new
 * chat shows them whole at once rather than waiting for them to be written or to load.
 */
export function StartingPointsReady() {
  const points = useStartingPointsKept();
  useEffect(() => {
    for (const { image } of points) if (image) preloadLogo(image, PICTURE);
  }, [points]);
  return null;
}

/**
 * What a point is about: its picture in a circle, as the portfolio shows a logo, or Auni's
 * mascot, cropped to its drawing so it reads as large as a round picture. A picture that won't
 * load shows the mascot too, never an empty circle.
 */
function PointImage({ image }: { readonly image: string | null }) {
  const mascot = (
    <Image alt="" src={tightMascot} width={PICTURE} height={PICTURE} className="flex-none" />
  );
  return (
    <span aria-hidden className="flex flex-none" style={{ width: PICTURE, height: PICTURE }}>
      {image ? <LogoImage src={image} size={PICTURE} fallback={mascot} /> : mascot}
    </span>
  );
}

/**
 * Where a point's claim about the markets came from, and when it was read: the app's name, or
 * for a part of Auni with no brand of its own (Prices) where it read, as its source says ("BTC on
 * the exchange it read"), then the time. Null for one resting only on the owner's own money and
 * takes, which Auni reads itself.
 */
export function seenOn(sources: readonly FactSource[], observedAt: string | null): string | null {
  const names = [
    ...new Set(
      sources.flatMap(({ app, label }) => {
        if (app === "auni") return [];
        const listing = appListing(app);
        return [listing?.glyph ? label : (listing?.name ?? app)];
      }),
    ),
  ];
  if (names.length === 0) return null;
  const from =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  if (!observedAt) return from!;
  const at = new Date(observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${from} at ${at}`;
}
