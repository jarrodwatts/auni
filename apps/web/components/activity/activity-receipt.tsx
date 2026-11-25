"use client";

import type { ActivityItemWire, ActivityStoryWire } from "@auni/shared";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Fragment, type MouseEvent, type ReactNode } from "react";

import { useStartNew } from "@/components/app/use-start-conversation";
import { AssetLogo, LogoImage } from "@/components/brand/marks";
import { PlaceLink } from "@/components/places/open-place";
import { buttonVariants } from "@/components/ui/button";
import { chatHref } from "@/lib/app-links";
import type { Thread } from "@/lib/data/views";
import { formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

import { amountText, TONE_CLASS_NAME } from "./activity-groups";

type ThreadRef = Pick<Thread, "id" | "title"> | undefined;

const OUTSIDE_RING = "flex rounded-full ring-2 ring-negative/70 ring-offset-1";

/**
 * What an item is about: its asset's logo, else for a move of cash alone the logo of where the
 * cash went (Hyperliquid's, for cash taken out of it), else a neutral glyph. One a venue did
 * that leaves the owner something to decide wears a ring in the loss colour.
 */
export function ItemMark({
  item,
  size,
}: {
  readonly item: ActivityItemWire;
  readonly size: number;
}) {
  const src =
    item.logo?.src ??
    (item.kind === "move"
      ? (item.receipt.steps.find((step) => step.logoUrl)?.logoUrl ?? null)
      : null);
  const logo = <AssetLogo holding={{ logoUrl: src }} size={size} />;
  return item.kind === "outside" && item.decision ? (
    <span className={OUTSIDE_RING}>{logo}</span>
  ) : (
    logo
  );
}

export function ActivityReceipt({
  item,
  thread,
}: {
  readonly item: ActivityItemWire;
  readonly thread: ThreadRef;
}) {
  return (
    <div className="flex flex-col px-6 pt-8 pb-7 sm:px-7">
      <div className="flex justify-center">
        <ItemMark item={item} size={60} />
      </div>
      <h2 className="mt-3.5 text-center text-section text-ink">{item.title}</h2>
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
        <p className={cn("mt-3 text-center text-hero-money", TONE_CLASS_NAME[item.amount.tone])}>
          {amountText(item.amount)}
        </p>
      ) : null}
      <div className="mt-6">
        {item.kind === "move" ? (
          <HowAuniDidIt receipt={item.receipt} thread={thread} />
        ) : item.kind === "outside" ? (
          <WhatHappened receipt={item.receipt} thread={thread} decision={item.decision} />
        ) : (
          <WhatArrived receipt={item.receipt} out={item.amount?.direction === "out"} />
        )}
      </div>
    </div>
  );
}

function HowAuniDidIt({
  receipt,
  thread,
}: {
  readonly receipt: Extract<ActivityItemWire, { kind: "move" }>["receipt"];
  readonly thread: ThreadRef;
}) {
  return (
    <>
      {receipt.story ? <Story story={receipt.story} /> : <Steps steps={receipt.steps} />}
      {thread ? <TakeLink thread={thread} /> : null}
    </>
  );
}

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
            <div key={label} className={cn("min-w-0", value.length > 18 && "col-span-2")}>
              <dt className="text-caption font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 text-body leading-[1.4] font-semibold tracking-[-0.01em] break-words text-ink tabular-nums">
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
              className={buttonVariants({ variant: "outline", size: "sm" })}
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

function Levels({ levels }: { readonly levels: ActivityStoryWire["levels"] }) {
  return (
    <ol className="mt-5 rounded-card border border-border bg-surface px-4 py-1.5">
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
          <span className="min-w-0 flex-1 text-ui text-muted-foreground">{label}</span>
          <span className="flex-none text-body font-semibold tracking-[-0.01em] text-ink tabular-nums">
            {price}
          </span>
        </li>
      ))}
    </ol>
  );
}

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
            <span className="min-w-0 flex-1 text-ui leading-5 text-ink">{step.text}</span>
            {step.amountUsd ? (
              <span className="flex-none text-ui text-muted-foreground tabular-nums">
                {formatUsd(step.amountUsd)}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}

function WhatHappened({
  receipt,
  thread,
  decision,
}: {
  readonly receipt: Extract<ActivityItemWire, { kind: "outside" }>["receipt"];
  readonly thread: ThreadRef;
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
      <p className="mt-4 text-center text-ui leading-[1.55] text-muted-foreground">{receipt.why}</p>
      {!decision ? (
        thread ? (
          <TakeLink thread={thread} />
        ) : null
      ) : thread ? (
        <PrimaryLink href={chatHref(thread.id)} thread={thread}>
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
    <div className="min-w-0 flex-1 rounded-card border border-border bg-surface px-3 py-3 text-center">
      <p className="text-caption font-medium text-faint">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-body leading-5 font-semibold break-words tabular-nums",
          TONE_CLASS_NAME[tone],
        )}
      >
        {value}
      </p>
      {place ? (
        <p className="mt-0.5 text-caption font-medium text-muted-foreground">on {place}</p>
      ) : null}
    </div>
  );
}

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
    <dl className="rounded-card border border-border bg-surface px-4 py-1">
      {facts.map(([label, value]) => (
        <div
          key={label}
          className="flex items-baseline gap-4 py-2.5 text-ui [&:not(:first-child)]:border-t [&:not(:first-child)]:border-foreground/[0.06]"
        >
          <dt className="flex-none text-muted-foreground">{label}</dt>
          <dd className="min-w-0 flex-1 text-right break-words text-ink tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const PRIMARY = buttonVariants({ className: "mt-6 w-full" });

/** The take a move belongs to, and the way to its chat. */
function TakeLink({ thread }: { readonly thread: NonNullable<ThreadRef> }) {
  return (
    <div className="mt-6 flex items-center gap-3 border-t border-border pt-4">
      <div className="min-w-0 flex-1">
        <p className="text-caption text-muted-foreground">Take</p>
        <p className="truncate text-ui font-medium text-ink">{thread.title}</p>
      </div>
      <PlaceLink
        href={chatHref(thread.id)}
        thread={thread.id}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        View chat
      </PlaceLink>
    </div>
  );
}

function PrimaryLink({
  href,
  thread,
  onClick,
  children,
}: {
  readonly href: string;
  readonly thread?: NonNullable<ThreadRef>;
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly children: ReactNode;
}) {
  return thread ? (
    <PlaceLink href={href} thread={thread.id} className={PRIMARY}>
      {children}
    </PlaceLink>
  ) : (
    <Link href={href} onClick={onClick} className={PRIMARY}>
      {children}
    </Link>
  );
}
