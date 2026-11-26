"use client";

import { APP_JOBS, type AppWire } from "@auni/shared";
import { Blocks } from "lucide-react";

import { cn } from "@/lib/utils";

import { JOBS } from "./app-jobs";
import { AppMark } from "./app-mark";
import { needOf } from "./app-standing";

/** One that needs something first, then the one in use, then by name. */
function inOrder(a: AppWire, b: AppWire): number {
  const rank = (app: AppWire) => (needOf(app) ? 0 : app.inUse ? 1 : 2);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/**
 * The plumbing: the apps Auni's own work runs on, by the job each does. None has a switch,
 * since turning a price feed or a swap route off would quietly break what depends on it. One
 * that needs something says so and comes first; any of them opens its sheet.
 */
export function RunsOn({
  apps,
  onOpen,
}: {
  readonly apps: readonly AppWire[];
  readonly onOpen: (id: string) => void;
}) {
  const rows = [
    ...APP_JOBS.map((job) => ({
      label: JOBS[job].label,
      icon: JOBS[job].icon,
      apps: apps.filter(({ jobs }) => jobs.includes(job)).toSorted(inOrder),
    })),
    // Whatever does none of those jobs is still part of this Auni.
    {
      label: "Also here",
      icon: Blocks,
      apps: apps.filter(({ jobs }) => jobs.length === 0).toSorted(inOrder),
    },
  ].filter((row) => row.apps.length > 0);
  return (
    <dl className="flex flex-col gap-5 sm:gap-3">
      {rows.map((row) => (
        <div key={row.label} className="sm:flex sm:items-start sm:gap-4">
          <dt className="flex items-center gap-2.5 text-ui font-normal text-ink sm:h-10 sm:w-[212px] sm:flex-none">
            <row.icon
              aria-hidden
              className="size-[17px] flex-none text-muted-foreground"
              strokeWidth={1.75}
            />
            {row.label}
          </dt>
          <dd className="mt-2 flex min-w-0 flex-1 flex-wrap gap-1.5 sm:mt-0">
            {row.apps.map((app) => (
              <Chip key={app.id} app={app} onOpen={() => onOpen(app.id)} />
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One app as a name to tap: its mark, its name, and in a quieter voice how it stands. */
function Chip({ app, onOpen }: { readonly app: AppWire; readonly onOpen: () => void }) {
  const need = needOf(app);
  // A brain or wallet app another is doing the job of says so by standing back.
  const says = need ?? (app.inUse ? app.standing : (app.standing ?? "Not in use"));
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      data-testid="runs-on-app"
      data-app={app.id}
      className={cn(
        "flex h-10 max-w-full items-center gap-2.5 rounded-full bg-surface pr-4 pl-1.5 text-ui outline-none transition-colors duration-150 hover:bg-foreground/[0.06] focus-visible:ring-[3px] focus-visible:ring-ring/50",
        need && "bg-waiting-surface hover:bg-waiting/[0.14]",
      )}
    >
      <span className={cn("flex-none", !app.inUse && "opacity-55 grayscale")}>
        <AppMark id={app.id} name={app.name} size={28} />
      </span>
      <span
        className={cn("flex-none font-medium", app.inUse ? "text-ink" : "text-muted-foreground")}
      >
        {app.name}
      </span>
      {says ? (
        <span className={cn("min-w-0 truncate", need ? "text-waiting" : "text-muted-foreground")}>
          {says}
        </span>
      ) : null}
    </button>
  );
}
