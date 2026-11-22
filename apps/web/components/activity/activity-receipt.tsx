"use client";

import type { ActivityItemWire, ActivityStoryWire } from "@auni/shared";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Fragment, type MouseEvent, type ReactNode } from "react";

import { useStartNew } from "@/components/app/use-start-conversation";
import { Mascot } from "@/components/brand/mascot";
import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { AssetLogo, LogoImage } from "@/components/specialist/marks";
import { PlaceLink } from "@/components/places/open-place";
import { specialistHref } from "@/lib/app-links";
import type { Specialist } from "@/lib/data/views";
import { formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

import { amountText, TONE_CLASS_NAME } from "./activity-groups";

type Owner = Pick<Specialist, "id" | "theme" | "name"> | undefined;

/** Something done to them rather than by them: its coin, ringed in the loss color. */
const OUTSIDE_RING = "flex rounded-full ring-2 ring-negative/70 ring-offset-1";

/**
 * What an item is about, as its row wears it: a move its specialist's orb, a
 * venue acting by itself the coin it acted on, ringed when it leaves them a
 * decision, money arriving its asset.
 */
export function ItemMark({
  item,
  owner,
  size,
}: {
  readonly item: ActivityItemWire;
  readonly owner: Owner;
  readonly size: number;
}) {
  if (item.kind === "move" && owner) return <SpecialistOrb specialist={owner} size={size} />;
  // A move made in Auni's own chat that is about no one asset (a routine saved, cash brought
  // back) wears Auni itself, never the initials of the sentence that names it.
  if (!item.logo) return <AuniMark size={size} />;
  const logo = <AssetLogo holding={{ logoUrl: item.logo.src, name: item.logo.name }} size={size} />;
  // Ringed around the logo, not on it: initials standing in for one draw their own shadow.
  return item.kind === "outside" && item.decision ? (
    <span className={OUTSIDE_RING}>{logo}</span>
  ) : (
    logo
  );
}

/** Auni, as who made a move: its mascot on a soft round tile, the size of the logos beside it. */
function AuniMark({ size }: { readonly size: number }) {
  return (
    <span
      aria-hidden
      className="flex flex-none items-center justify-center rounded-full bg-muted"
      style={{ width: size, height: size }}
    >
      <Mascot alt="" size={Math.round(size * 0.66)} />
    </span>
  );
}

/**
 * One item in full, like a receipt: its mark, what it was and whose, the
 * amount, then what it was made of. A move lists how Auni did it, step by
 * step, with its fee; something a venue did shows the position before and
 * after and why, and offers to ask Auni what now; money that arrived says
 * how much, on which network, and from whom.
 */
export function ActivityReceipt({
  item,
  owner,
}: {
  readonly item: ActivityItemWire;
  readonly owner: Owner;
}) {
  return (
    <div className="flex flex-col px-6 pt-8 pb-7 sm:px-7">
      <div className="flex justify-center">
        {item.kind === "outside" && item.logo ? (
          <span className="relative flex">
            <AssetLogo holding={{ logoUrl: item.logo.src, name: item.logo.name }} size={60} />
            {owner ? (
              // The orb draws its own shadow, so its white edge is a disc behind it.
              <span className="absolute -right-1.5 -bottom-1.5 flex rounded-full bg-popover p-[2px]">
                <SpecialistOrb specialist={owner} size={24} />
              </span>
            ) : null}
          </span>
        ) : (
          <ItemMark item={item} owner={owner} size={60} />
        )}
      </div>
      <h2 className="mt-3.5 text-center text-[18px] leading-6 font-semibold tracking-[-0.015em] text-ink">
        {item.title}
      </h2>
      <p className="mt-1 text-center text-meta text-muted-foreground">
        {item.kind === "outside" ? (
          <>
            by {item.receipt.by}
            <br />
          </>
        ) : null}
        {item.subtitle}
      </p>
      {item.amount ? (
        <p
          className={cn(
            "mt-3 text-center text-[40px] leading-[1.15] font-semibold tracking-[-0.03em] tabular-nums",
            TONE_CLASS_NAME[item.amount.tone],
          )}
        >
          {amountText(item.amount)}
        </p>
      ) : null}
      <div className="mt-6">
        {item.kind === "move" ? (
          <HowAuniDidIt receipt={item.receipt} owner={owner} />
        ) : item.kind === "outside" ? (
          <WhatHappened receipt={item.receipt} owner={owner} decision={item.decision} />
        ) : (
          <WhatArrived receipt={item.receipt} out={item.amount?.direction === "out"} />
        )}
      </div>
    </div>
  );
}

/**
 * How Auni did it: a move of one step as its story (what left and what arrived, side by side,
 * then its price, the services it went through and where to see it), else each step down one
 * track, the way it ran, small logos at its stops.
 */
function HowAuniDidIt({
  receipt,
  owner,
}: {
  readonly receipt: Extract<ActivityItemWire, { kind: "move" }>["receipt"];
  readonly owner: Owner;
}) {
  return (
    <>
      {receipt.story ? <Story story={receipt.story} /> : <Steps steps={receipt.steps} />}
      {owner ? (
        <PrimaryLink href={specialistHref(owner.id)} specialist={owner}>
          Open {owner.name}
        </PrimaryLink>
      ) : null}
    </>
  );
}

/**
 * One move as a small scene: what left and what arrived (or what a position did and what that
 * made or lost) as tiles with an arrow between, each saying where; under them the prices it moved
 * between on one line, highest first, then its price and the services it went through, and its
 * transactions on their chains' explorers.
 */
function Story({ story }: { readonly story: ActivityStoryWire }) {
  const sides = [story.gave, story.got].filter((side) => side !== null);
  return (
    <>
      {sides.length > 0 ? (
        <div className="flex items-stretch gap-2.5">
          {sides.map((side, index) => (
            <Fragment key={side.label}>
              {index > 0 ? (
                <ArrowRight
                  aria-hidden
                  className="size-4 flex-none self-center text-faint"
                  strokeWidth={2}
                />
              ) : null}
              <Side {...side} />
            </Fragment>
          ))}
        </div>
      ) : null}
      {story.levels.length > 0 ? <Levels levels={story.levels} /> : null}
      {story.facts.length > 0 ? (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
          {story.facts.map(({ label, value }) => (
            <div
              key={label}
              // A long line of services takes the row to itself.
              className={cn("min-w-0", value.length > 18 && "col-span-2")}
            >
              <dt className="text-caption text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 text-[15px] leading-[1.4] font-semibold tracking-[-0.01em] break-words text-ink tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {story.links.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {story.links.map(({ label, url }) => (
            <a
              key={url}
              className="flex h-9 items-center gap-1.5 rounded-full border border-foreground/[0.08] px-4 text-meta font-medium text-ink transition-colors duration-150 hover:bg-surface focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              href={url}
              rel="noreferrer"
              target="_blank"
            >
              {label}
              <ArrowUpRight
                aria-hidden
                className="size-3.5 text-muted-foreground"
                strokeWidth={2.2}
              />
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * A move's prices on one line, highest first, as a chart would stack them: where a position was
 * entered and closed, or the price then, as solid stops on the line, and each stop-loss or
 * take-profit waiting on it as an open one.
 */
function Levels({ levels }: { readonly levels: ActivityStoryWire["levels"] }) {
  return (
    <ol className="mt-5 rounded-[16px] bg-surface px-4 py-1.5">
      {levels.map(({ label, price, kind }) => (
        <li
          key={label}
          className="relative flex min-h-10 items-center gap-3 [&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:top-[calc(50%+6px)] [&:not(:last-child)]:after:-bottom-[calc(50%-6px)] [&:not(:last-child)]:after:left-[4.5px] [&:not(:last-child)]:after:w-px [&:not(:last-child)]:after:bg-foreground/[0.14]"
        >
          <span
            aria-hidden
            className={cn(
              "size-2.5 flex-none rounded-full",
              kind === "price" ? "bg-ink" : "border-[1.5px] border-muted-foreground bg-surface",
            )}
          />
          <span className="min-w-0 flex-1 text-[14px] text-muted-foreground">{label}</span>
          <span className="flex-none text-[15px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
            {price}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Each step down one track, the way it ran, small logos at its stops. */
function Steps({
  steps,
}: {
  readonly steps: Extract<ActivityItemWire, { kind: "move" }>["receipt"]["steps"];
}) {
  return (
    <>
      <h3 className="text-meta font-medium text-faint">How Auni did it</h3>
      <ol className="mt-2">
        {steps.map((step, index) => (
          <li
            key={index}
            className="relative flex min-h-11 items-center gap-3 py-1.5 [&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:top-[34px] [&:not(:last-child)]:after:-bottom-[10px] [&:not(:last-child)]:after:left-[11.5px] [&:not(:last-child)]:after:w-px [&:not(:last-child)]:after:bg-foreground/[0.1]"
          >
            <LogoImage
              src={step.logoUrl}
              size={24}
              fallback={
                <span className="flex size-6 flex-none items-center justify-center rounded-full bg-surface">
                  <span className="size-2 rounded-full bg-faint" />
                </span>
              }
            />
            <span className="min-w-0 flex-1 text-[14px] leading-5 text-ink">{step.text}</span>
            {step.amountUsd ? (
              <span className="flex-none text-[14px] text-muted-foreground tabular-nums">
                {formatUsd(step.amountUsd)}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}

/** The position before and after, why it happened, and, when it's theirs to decide, the way to. */
function WhatHappened({
  receipt,
  owner,
  decision,
}: {
  readonly receipt: Extract<ActivityItemWire, { kind: "outside" }>["receipt"];
  readonly owner: Owner;
  readonly decision: boolean;
}) {
  const startNew = useStartNew();
  return (
    <>
      <div className="flex items-center gap-2.5">
        <Side label="Before" value={receipt.before} />
        <ArrowRight aria-hidden className="size-4 flex-none text-faint" strokeWidth={2} />
        <Side label="After" value={receipt.after} />
      </div>
      <p className="mt-4 text-center text-[14px] leading-[1.55] text-muted-foreground">
        {receipt.why}
      </p>
      {!decision ? null : owner ? (
        <PrimaryLink href={specialistHref(owner.id)} specialist={owner}>
          Ask Auni what now
        </PrimaryLink>
      ) : (
        <PrimaryLink href="/app/new" onClick={startNew}>
          Ask Auni what now
        </PrimaryLink>
      )}
    </>
  );
}

/**
 * One side of what happened, on a soft tile: what it was, and where, when that's said; what a
 * position made or lost in the gain or loss color.
 */
function Side({
  label,
  value,
  place,
  tone = "neutral",
}: {
  readonly label: string;
  readonly value: string;
  readonly place?: string | null;
  readonly tone?: keyof typeof TONE_CLASS_NAME;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-[16px] bg-surface px-3 py-3 text-center">
      <p className="text-caption text-faint">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-[15px] leading-5 font-semibold break-words tabular-nums",
          TONE_CLASS_NAME[tone],
        )}
      >
        {value}
      </p>
      {place ? <p className="mt-0.5 text-caption text-muted-foreground">on {place}</p> : null}
    </div>
  );
}

/** How much came in or went out, on which network, and who was on the other side. */
function WhatArrived({
  receipt,
  out,
}: {
  readonly receipt: Extract<ActivityItemWire, { kind: "arrival" }>["receipt"];
  readonly out: boolean;
}) {
  const facts: (readonly [string, string])[] = [
    [
      out ? "Sent" : "Received",
      receipt.moved.map(({ amount, symbol }) => `${amount} ${symbol}`).join(" and "),
    ],
    ["Network", receipt.network],
  ];
  if (receipt.counterparty) facts.push([out ? "To" : "From", receipt.counterparty]);
  return (
    <dl className="rounded-[16px] bg-surface px-4 py-1">
      {facts.map(([label, value]) => (
        <div
          key={label}
          className="flex items-baseline gap-4 py-2.5 text-[14px] [&:not(:first-child)]:border-t [&:not(:first-child)]:border-foreground/[0.06]"
        >
          <dt className="flex-none text-muted-foreground">{label}</dt>
          <dd className="min-w-0 flex-1 text-right break-words text-ink tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const PRIMARY =
  "mt-6 flex h-10 w-full items-center justify-center rounded-full bg-foreground px-5 text-ui font-semibold text-background transition-[background-color,transform] duration-200 ease-settle hover:bg-foreground/85 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97]";

function PrimaryLink({
  href,
  specialist,
  onClick,
  children,
}: {
  readonly href: string;
  readonly specialist?: NonNullable<Owner>;
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly children: ReactNode;
}) {
  return specialist ? (
    <PlaceLink href={href} specialist={specialist.id} className={PRIMARY}>
      {children}
    </PlaceLink>
  ) : (
    <Link href={href} onClick={onClick} className={PRIMARY}>
      {children}
    </Link>
  );
}
