"use client";

import type { AppJob, AppWire } from "@auni/shared";

import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { Eyebrow, Section } from "@/components/ui/section";
import { cn } from "@/lib/utils";

import { JOBS } from "./app-jobs";
import { AppMark } from "./app-mark";
import { needOf } from "./app-standing";

/**
 * The jobs Apps shows the services for. Thinking and keeping the keys are the owner's AI and
 * wallet, which Settings holds.
 */
const SHOWN: readonly AppJob[] = ["trades", "moves", "prices", "watches"];

/**
 * An app the owner acts through, with a switch of its own: a venue, a research feed. Their AI,
 * their wallet and their chats are in Settings.
 */
export function isYours(app: AppWire): boolean {
  return app.canSwitch && app.pairing === null;
}

/** One that needs something first, then by name. */
function inOrder(a: AppWire, b: AppWire): number {
  return Number(!needOf(a)) - Number(!needOf(b)) || a.name.localeCompare(b.name);
}

/**
 * The services Auni uses on its own, by the job each does: routing a trade, moving cash across
 * chains, pricing a token, watching the clock and the market. None has a switch, since turning
 * one off would quietly break what depends on it. Any of them opens its sheet, which shows the
 * job as a scene.
 */
export function BehindTheScenes({
  apps,
  onOpen,
}: {
  readonly apps: readonly AppWire[];
  readonly onOpen: (id: string) => void;
}) {
  const groups = SHOWN.map((job) => ({
    job,
    apps: apps.filter(({ canSwitch, jobs }) => !canSwitch && jobs.includes(job)).toSorted(inOrder),
  })).filter((group) => group.apps.length > 0);
  if (groups.length === 0) return null;
  return (
    <Section
      heading="Behind the scenes"
      description="What Auni uses on its own to find prices, route trades, and move cash."
    >
      <div className="mt-5 flex flex-col gap-6">
        {groups.map((group) => (
          <div key={group.job}>
            <Eyebrow className="mb-1">{JOBS[group.job].label}</Eyebrow>
            <ul className="grid gap-x-6 sm:grid-cols-2">
              {group.apps.map((app) => (
                <li key={app.id}>
                  <Plumbing app={app} onOpen={() => onOpen(app.id)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** One service Auni uses: its logo, its name, and what it needs, if anything. */
function Plumbing({ app, onOpen }: { readonly app: AppWire; readonly onOpen: () => void }) {
  const need = needOf(app);
  return (
    <Row
      asChild
      aria-haspopup="dialog"
      data-testid="runs-on-app"
      data-app={app.id}
      className="min-h-12 py-2"
      mark={
        <span className={cn(!app.inUse && "opacity-55 grayscale")}>
          <AppMark id={app.id} name={app.name} size={28} />
        </span>
      }
      title={app.name}
      end={need ? <Badge tone="waiting">{need}</Badge> : null}
    >
      <button type="button" onClick={onOpen} />
    </Row>
  );
}
