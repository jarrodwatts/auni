"use client";

import { appListing, STARTING_POINTS, type FactSource } from "@auni/shared";
import { RefreshCw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useStartConversation } from "@/components/app/use-start-conversation";
import { useMoney } from "@/components/money/money-provider";
import { useMe } from "@/components/personalization/use-me";
import { LogoImage, preloadLogo } from "@/components/specialist/marks";
import {
  useRefreshStartingPoints,
  useStartingPoints,
  useStartingPointsKept,
} from "@/lib/data/starting-points";
import { formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";
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
// comes from the rhythm. A row lightens under a pointer. On a phone the words may run to the
// row's edge, which keeps no padding there.
const ROW = "flex h-[52px] w-full items-center rounded-[14px] pr-0 text-left sm:pr-3";
const ROW_SPACING = { paddingLeft: INSET, gap: GAP } as const;

/**
 * Ways into a new chat, drawn from what Auni sees of the owner (core's starting points), each
 * wearing a picture of what it's about. A tap starts the chat with its prompt.
 */
export function StartingPoints() {
  const { busy, error, start } = useStartConversation();
  const { points, waiting, pending } = useStartingPoints();
  const refresh = useRefreshStartingPoints();
  const { portfolio } = useMoney();
  const me = useMe();
  const { addMoneyHref, settingsHref } = useAppDialogs();
  const needsSignals = !me.xHandle && me.watchedWallets.length === 0;

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
                disabled={busy}
                onClick={() => void start(point.prompt)}
                title={point.sources.map(cited).join("\n")}
                style={ROW_SPACING}
                className={`${ROW} text-[15px] tracking-[-0.01em] transition-colors sm:text-[16px] duration-150 hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60`}
              >
                {/* 15px on a phone, PHONE_TEXT_PX, which core measures each line at (lineFits). */}
                <PointImage image={point.image} />
                {/* Should a line still run long, what's true shortens; what to do never does. */}
                <span className="flex min-w-0 flex-1 items-baseline gap-[0.25em]">
                  <span className="min-w-0 truncate text-ink">{point.statement}</span>
                  <span className="flex-none whitespace-nowrap text-muted-foreground">
                    {point.action}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Always one line tall: their money is read after the page draws, and a line arriving
          then would push the page, which is centred, up by half of it. */}
      <div
        className="mt-2 flex h-5 items-center justify-between gap-3 pr-2 text-[13px] leading-5 text-muted-foreground"
        style={{ paddingLeft: WORDS_START }}
      >
        <span className="min-w-0 truncate">
          {portfolio?.empty ? (
            <span className="auni-stagger-in inline-block">
              Balance {formatUsdcBalance(0n)}.{" "}
              <Link
                href={addMoneyHref}
                scroll={false}
                className="font-medium text-primary transition-opacity hover:opacity-75"
              >
                Add money
              </Link>
              {needsSignals ? (
                <>
                  {" or "}
                  <Link
                    href={settingsHref("personalization")}
                    scroll={false}
                    className="transition-colors hover:text-ink"
                  >
                    tailor with X or wallet
                  </Link>
                </>
              ) : null}
            </span>
          ) : needsSignals ? (
            <Link
              href={settingsHref("personalization")}
              scroll={false}
              className="transition-colors hover:text-ink"
            >
              Connect X or a watch-only wallet for tailored ideas
            </Link>
          ) : null}
        </span>
        {!waiting ? (
          <button
            type="button"
            disabled={refresh.isPending || pending}
            onClick={() => refresh.mutate()}
            className="inline-flex flex-none items-center gap-1 text-[12px] text-faint transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshCw
              aria-hidden
              className={cn("size-3", (refresh.isPending || pending) && "animate-spin")}
            />
            <span>Refresh</span>
          </button>
        ) : null}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-center text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
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

/** Where a source came from, as its row's tooltip says it: the app's name, then what it saw. */
function cited(source: FactSource): string {
  const from = source.app === "auni" ? "Auni" : (appListing(source.app)?.name ?? source.app);
  return `${from}: ${source.label}`;
}
