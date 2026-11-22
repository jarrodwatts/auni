"use client";

import { appListing, type AppWire } from "@auni/shared";
import { ArrowRight } from "lucide-react";
import type { CSSProperties } from "react";

import { AssetLogo } from "@/components/specialist/marks";
import { cn } from "@/lib/utils";

import { AppMark, appTint } from "./app-mark";
import { appStanding, needOf } from "./app-standing";

/** The most holdings a tile shows the logos of. */
const LOGOS_SHOWN = 3;

/**
 * Resting, a quiet fill with a whisper of the app's own colour behind its mark; under the
 * pointer the colour comes up a little. Nothing moves until it's pressed.
 */
const TILE = [
  "group relative isolate flex min-h-[172px] w-full min-w-0 flex-col overflow-hidden rounded-[22px] bg-surface p-4 text-left outline-none",
  "transition-[scale] duration-300 ease-settle active:scale-[0.985] active:duration-100 motion-reduce:transition-none motion-reduce:active:scale-100",
  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
].join(" ");

/**
 * One app the owner acts through: its mark and name, what it does in a line, and one thing in
 * words: the money they have there, the one thing it still needs, or that it is off.
 */
export function AppTile({ app, onOpen }: { readonly app: AppWire; readonly onOpen: () => void }) {
  const listing = appListing(app.id);
  const standing = appStanding(app);
  // What is held there, by its pictures; one that is only the app's own logo again says nothing.
  const held = (standing.tone === "money" ? (app.account?.holdings ?? []) : []).filter(
    ({ logoUrl }) => logoUrl !== listing?.logo,
  );
  const off = standing.tone === "off";
  // What it waits on or what goes wrong for it is said the same way, with money there or without.
  const calls = !off && needOf(app) !== null;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`${app.name}: ${standing.says}, ${standing.under}`}
      onClick={onOpen}
      className={TILE}
      data-testid="app-tile"
      data-app={app.id}
      data-tone={standing.tone}
      style={{ "--app-tint": appTint(app.id) } as CSSProperties}
    >
      {off ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-[70px] -left-[70px] -z-10 size-[230px] opacity-70 transition-opacity duration-300 ease-settle group-hover:opacity-100 [background:radial-gradient(closest-side,var(--app-tint),transparent)]"
        />
      )}
      <span className={cn("flex items-start", off && "opacity-55 grayscale")}>
        <AppMark id={app.id} name={app.name} size={44} />
        <ArrowRight
          aria-hidden
          className="mt-1 ml-auto size-4 flex-none text-faint opacity-0 transition-[opacity,translate] duration-300 ease-settle group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100"
          strokeWidth={2.2}
        />
      </span>
      <span className="mt-3 block truncate text-reading leading-[22px] text-ink">{app.name}</span>
      <span className="block truncate text-meta text-muted-foreground">{app.does}</span>
      <span className="mt-auto flex items-end gap-3 pt-4">
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-ink tabular-nums",
              standing.tone === "money"
                ? "text-amount leading-none tracking-[-0.03em]"
                : "text-ui leading-6 font-semibold tracking-[-0.01em]",
              off && "text-muted-foreground",
            )}
          >
            {standing.says}
          </span>
          <span
            className={cn(
              "mt-1 block truncate text-meta leading-4",
              calls && standing.tone === "money" ? "font-medium text-ink" : "text-muted-foreground",
            )}
          >
            {standing.under}
          </span>
        </span>
        {standing.setUp ? (
          <span className="mb-0.5 flex h-8 flex-none items-center rounded-full bg-foreground px-3.5 text-meta font-semibold text-background transition-colors duration-200 ease-settle group-hover:bg-foreground/85">
            Set up
          </span>
        ) : held.length > 0 ? (
          <span className="flex flex-none items-center pb-0.5">
            {held.slice(0, LOGOS_SHOWN).map((holding, index) => (
              <span
                key={holding.id}
                className="rounded-full ring-2 ring-surface"
                style={{ marginLeft: index === 0 ? 0 : -8, zIndex: LOGOS_SHOWN - index }}
              >
                <AssetLogo holding={holding} size={26} />
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}
