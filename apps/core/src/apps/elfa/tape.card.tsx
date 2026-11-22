"use client";

import { useMemo, useState } from "react";

import { AuniNote } from "@/components/cards/auni-note";
import { brandHue, useBrandColors } from "@/components/brand/brand-colors";
import { useMinute } from "@/components/places/use-places";
import { AUNI_HUE, DawnChart, type ChartHue } from "@/components/portfolio/dawn-chart";
import {
  MOMENT_COLOR,
  MomentTrigger,
  NOTE_LINE_TONE,
  useMomentCards,
  type ChartMoment,
  type MomentNote,
  type MomentTone,
} from "@/components/portfolio/dawn-moments";
import { RollingNumber } from "@/components/portfolio/rolling-number";
import { formatAssetPrice, formatPercentChange } from "@/lib/money";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import type { Tape } from "./tape.schema.ts";

type TapeStory = Tape["stories"][number];

/**
 * "The tape": one asset's week as a line, with every story Elfa wrote up
 * about it sitting on the line where it landed, the two that explain the
 * week written beside their beads, and Auni's own read under it.
 */

const SCRUBBED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
});
const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** "12 minutes ago", "yesterday", "3 days ago". */
function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return RELATIVE.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return RELATIVE.format(-hours, "hour");
  return RELATIVE.format(-Math.round(hours / 24), "day");
}

function tone(story: TapeStory): MomentTone {
  if (story.implication === "bullish") return "positive";
  if (story.implication === "bearish") return "negative";
  return "neutral";
}

/** What came of a story: the next day's move in words once measured, how long ago until then. */
function aftermath(story: TapeStory, now: number): Omit<MomentNote, "title"> {
  const move = story.reactionPct === null ? null : Math.round(story.reactionPct * 10) / 10;
  if (move === null) return { line: ago(Date.parse(story.at), now), lineTone: "faint" };
  if (move === 0) return { line: "Flat the next day", lineTone: "faint" };
  return {
    line: `${move > 0 ? "Up" : "Down"} ${Math.abs(move).toFixed(1)}% the next day`,
    lineTone: move > 0 ? "positive" : "negative",
  };
}

/** A logo's color as the line's hue; Auni blue until it's read, and for a mark that can't be read or has no color. */
function useAssetHue(logoUrl: string | null): ChartHue {
  const colors = useBrandColors(logoUrl);
  const hue = colors && brandHue(colors);
  return hue ? { h: Math.round(hue.h), s: Math.round(hue.s * 100) } : AUNI_HUE;
}

/** Only a web link opens; anything else stays words. */
function webLink(link: string | null): string | null {
  if (!link || !URL.canParse(link)) return null;
  const { protocol } = new URL(link);
  return protocol === "https:" || protocol === "http:" ? link : null;
}

/** The chart's name ends on how many stories sit on it: ", with one story on it", or nothing for none. */
function storyCount(count: number): string {
  if (count === 0) return "";
  return `, with ${count === 1 ? "one story" : `${count} stories`} on it`;
}

function sourceName({ platform, handle }: TapeStory["sources"][number]): string {
  if (handle) return platform === "x" ? `@${handle.replace(/^@/u, "")}` : handle;
  return platform === "x" ? "a post on X" : platform === "telegram" ? "Telegram" : "a post";
}

/** The story itself, in the card a bead opens: Elfa's words, shown as they are. */
function Story({ story, now }: { readonly story: TapeStory; readonly now: number }) {
  const { line, lineTone } = aftermath(story, now);
  const more = story.sourceCount - story.sources.length;
  return (
    <>
      <p className="text-[13.5px] leading-[18px] font-semibold tracking-[-0.01em] text-pretty">
        {story.title}
      </p>
      {story.summary ? (
        <p className="mt-1 line-clamp-6 text-[13px] leading-[1.45] text-pretty text-muted-foreground">
          {story.summary}
        </p>
      ) : null}
      <p
        className={cn(
          "mt-2 text-[12px] leading-4 font-medium tabular-nums",
          NOTE_LINE_TONE[lineTone],
        )}
      >
        {line}
      </p>
      {story.sources.length ? (
        <p className="mt-1.5 text-[12px] leading-4 text-muted-foreground">
          From{" "}
          {story.sources.map((source, index) => {
            const href = webLink(source.link);
            const last = index === story.sources.length - 1;
            return (
              <span key={`${index}:${source.link ?? source.handle}`}>
                {index === 0 ? "" : last && more <= 0 ? " and " : ", "}
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink underline decoration-foreground/20 underline-offset-2 transition-colors hover:decoration-foreground/60"
                  >
                    {sourceName(source)}
                  </a>
                ) : (
                  sourceName(source)
                )}
              </span>
            );
          })}
          {more > 0 ? ` and ${more} more` : null}
        </p>
      ) : null}
    </>
  );
}

/** Each story as a moment on the line; the highlighted ones carry their note. */
function useMoments(card: Tape, now: number): ChartMoment[] {
  return useMemo(() => {
    const labels = new Map(card.highlights.map(({ storyId, label }) => [storyId, label]));
    return card.stories.map((story) => {
      const after = aftermath(story, now);
      const label = labels.get(story.id);
      return {
        key: story.id,
        at: Date.parse(story.at),
        tone: tone(story),
        label: `${story.title}, ${after.line}`,
        ...(label === undefined ? {} : { note: { title: label ?? story.title, ...after } }),
        detail: <Story story={story} now={now} />,
      };
    });
  }, [card, now]);
}

/** The tape, drawn from the data its card carries (see tape.schema.ts). */
export default function TapeCard({ data: card }: { readonly data: Tape }) {
  const now = useMinute();
  const moments = useMoments(card, now);
  const hue = useAssetHue(card.asset.logoUrl);
  const wide = useMediaQuery("(min-width: 640px)");
  // Scrubbing is for a pointer; on a phone the chart scrolls with the page and its beads take taps.
  const pointer = useMediaQuery("(pointer: fine)");
  const [scrub, setScrub] = useState<number | null>(null);
  const { price, asset } = card;
  const scrubbed = price && scrub !== null ? price.points[scrub] : undefined;
  const points = useMemo(
    () => price?.points.map((point) => ({ at: Date.parse(point.at), value: point.value })) ?? [],
    [price],
  );

  return (
    <section
      aria-label={`${asset.name}, past week`}
      className="relative my-2 w-full min-w-0 overflow-hidden rounded-[24px] border border-foreground/[0.07] bg-card pb-6 text-ink shadow-card"
      data-testid="market-pulse"
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-[22px]">
        <div className="min-w-0">
          <p className="truncate text-[13px] leading-[18px] text-muted-foreground">
            {asset.name}, past week
          </p>
          {price ? (
            <p className="mt-0.5 flex items-baseline gap-2">
              <span className="text-[30px] leading-9 font-semibold tracking-[-0.035em] text-ink tabular-nums">
                <RollingNumber value={formatAssetPrice(scrubbed?.value ?? price.now)} />
              </span>
              {scrubbed ? (
                <span className="text-[14px] leading-5 text-muted-foreground tabular-nums">
                  {SCRUBBED.format(new Date(scrubbed.at))}
                </span>
              ) : (
                <span
                  className={cn(
                    "text-[14px] leading-5 font-medium tabular-nums",
                    // Toned by what it rounds to, so a week that ends level reads as no move.
                    Math.round(price.weekChangePct * 10) > 0
                      ? "text-positive"
                      : Math.round(price.weekChangePct * 10) < 0
                        ? "text-negative"
                        : "text-muted-foreground",
                  )}
                >
                  {formatPercentChange(price.weekChangePct)}
                </span>
              )}
            </p>
          ) : null}
        </div>
        {/* Elfa's lockup, as it is: a vector at a fixed size, so the image server has nothing to do.
            Its cat is black, so it sits on a logo's plate: white on the white card, and a white
            pill on the dark one, where the cat would sink into the page. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt="Elfa"
          className="mt-0.5 box-content h-[13px] w-auto flex-none rounded-full bg-plate px-1.5 py-0.5"
          height={26}
          src="/brand/protocols/elfa-lockup.svg"
          width={76}
        />
      </div>
      {price ? (
        <DawnChart
          points={points}
          height={wide ? 220 : 190}
          hue={hue}
          label={`${asset.name}'s price over the past week${storyCount(card.stories.length)}`}
          moments={moments}
          {...(pointer ? { onScrub: setScrub } : {})}
          className="mt-1"
        />
      ) : (
        <Stories stories={card.stories} moments={moments} now={now} />
      )}
      <AuniNote className="mx-6 mt-4">{card.take}</AuniNote>
    </section>
  );
}

/** With nothing to draw the week on, its stories as a quiet list, newest first. */
function Stories({
  stories,
  moments,
  now,
}: {
  readonly stories: readonly TapeStory[];
  readonly moments: readonly ChartMoment[];
  readonly now: number;
}) {
  const cards = useMomentCards();
  if (!moments.length) return null;
  return (
    <ul className="mt-3 flex flex-col px-3.5">
      {stories.toReversed().map((story) => {
        const moment = moments.find(({ key }) => key === story.id)!;
        const { line, lineTone } = aftermath(story, now);
        return (
          <li key={moment.key}>
            <MomentTrigger
              moment={moment}
              cards={cards}
              className="flex w-full items-start gap-3 rounded-[12px] px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/50 data-[open]:bg-foreground/[0.03]"
            >
              <span
                aria-hidden
                className="mt-[7px] size-[7px] flex-none rounded-full"
                style={{ background: MOMENT_COLOR[moment.tone] }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-5 font-medium text-ink">
                  {story.title}
                </span>
                <span
                  className={cn(
                    "block text-[12.5px] leading-[18px] tabular-nums",
                    NOTE_LINE_TONE[lineTone],
                  )}
                >
                  {line}
                </span>
              </span>
            </MomentTrigger>
          </li>
        );
      })}
    </ul>
  );
}
