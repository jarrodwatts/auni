"use client";

import type { AutomationFireWire, AutomationWire } from "@auni/shared";
import { Trash2 } from "lucide-react";

import { Mascot } from "@/components/brand/mascot";
import { useSpecialists } from "@/components/specialist/use-specialists";
import { AuniSheet } from "@/components/ui/auni-sheet";
import { Switch } from "@/components/ui/switch";
import type { WatchScope } from "@/lib/data/automations";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import { WatchIcon, watchSource } from "./watch-icon";
import {
  liveWatches,
  useDeleteWatch,
  useSetWatchPaused,
  useWatchFires,
  useWatches,
} from "./use-watches";
import { isToday, spokeAt } from "./watch-time";

const MONTH_MS = 30 * 24 * 60 * 60 * 1_000;

function things(count: number): string {
  return count === 1 ? "1 thing" : `${count} things`;
}

function spokeThisMonth(fires: readonly AutomationFireWire[]): string {
  const count = fires.filter(
    ({ firedAt, verdict }) => verdict === "wake" && Date.now() - Date.parse(firedAt) < MONTH_MS,
  ).length;
  if (count === 0) return "Quiet so far";
  return count === 1 ? "Spoke up once this month" : `Spoke up ${count} times this month`;
}

/** What Auni made of a fire before any turn: told now, kept for the brief, or just noted. */
function verdictLine({ verdict, reason }: AutomationFireWire): string {
  const said = reason ? `: ${reason}` : "";
  if (verdict === "wake") return `Told you${said}`;
  if (verdict === "brief") return `Saved for your brief${said}`;
  if (verdict === "note") return `Just noted${said}`;
  return "Deciding whether it matters";
}

/**
 * What Auni watches, calmly: the latest times it spoke up and what it made of
 * them, then each watch in one card: what it looks out for, why Auni keeps it,
 * who watches it, a switch to pause it and a way to delete it. Auni listens
 * while any is on, under a faint wash of its own blue and peach.
 */
export function WatchSheet({
  scope,
  open,
  onOpenChange,
}: {
  readonly scope: WatchScope;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const watches = useWatches(scope).data ?? [];
  const fires = useWatchFires(scope, open).data ?? [];
  const specialistId = watches[0]?.specialistId;
  const specialist = useSpecialists().data?.find(({ id }) => id === specialistId);
  const live = liveWatches(watches);
  const on = live.filter(({ status }) => status === "active").length;
  const shown = watches.filter((watch) => live.includes(watch) || watch.status === "failed");

  return (
    <AuniSheet
      open={open}
      onOpenChange={onOpenChange}
      side={wide ? "right" : "bottom"}
      title="What Auni watches"
      // The wash sits in pixels from the top, so a phone's drag strip, which inherits it, lines up.
      className="bg-surface bg-[image:radial-gradient(360px_260px_at_15%_0,--alpha(var(--color-primary)/13%),transparent_70%),radial-gradient(280px_200px_at_100%_40px,--alpha(var(--color-blush-wash)/50%),transparent_70%)] bg-no-repeat"
    >
      <div className="auni-scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <Mascot
          alt=""
          size={56}
          state={on > 0 ? "listening" : "color"}
          className="drop-shadow-[0_8px_14px_--alpha(var(--color-primary)/22%)]"
        />
        <h2 className="mt-3 text-[25px] leading-[1.2] font-semibold tracking-[-0.03em] text-ink lg:pr-8 px-1">
          {on > 0 ? `Watching ${things(on)}` : "Not watching right now"}
        </h2>
        <p className="mt-1 px-1 text-[14.5px] text-muted-foreground">
          {specialist ? (
            <span className="block font-medium text-ink">{specialist.purpose}</span>
          ) : null}
          {spokeThisMonth(fires)}
        </p>

        {fires.length > 0 ? (
          <ol className="mt-4 px-1">
            {fires.slice(0, 3).map((fire, index) => (
              <li key={fire.id} className="flex gap-3 py-2">
                <span
                  aria-hidden
                  className={cn(
                    "mt-[7px] size-1.5 flex-none rounded-full",
                    index === 0 && isToday(fire.firedAt) ? "bg-primary" : "bg-foreground/[0.18]",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-muted-foreground">
                    {spokeAt(fire.firedAt)}
                    {fire.late ? ", about something that happened while I was asleep" : null}
                  </span>
                  <span className="mt-0.5 block text-[14.5px] leading-[1.45] text-ink">
                    {fire.outcome ?? fire.description}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-[1.4] text-muted-foreground">
                    {verdictLine(fire)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {shown.length > 0 ? (
          <ul className="mt-6 rounded-card bg-card shadow-[0_1px_2px_--alpha(var(--color-shade)/5%),0_0_0_1px_--alpha(var(--color-shade)/4%)]">
            {shown.map((watch) => (
              <li key={watch.id} className="group flex items-center gap-3 pl-3.5">
                <WatchIcon watch={watch} />
                {/* The hairline starts after the icon, as in a settings list. */}
                <div className="flex min-w-0 flex-1 items-center gap-3 border-b border-foreground/[0.06] py-3.5 pr-3.5 group-last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-[15px] leading-5",
                        watch.status === "active" ? "text-ink" : "text-muted-foreground",
                      )}
                    >
                      {watch.description}
                    </p>
                    {watch.note && watch.note !== watch.description ? (
                      <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.4] text-muted-foreground">
                        {watch.note}
                      </p>
                    ) : null}
                    <WatchState watch={watch} />
                  </div>
                  {watch.status === "failed" ? null : <WatchSwitch watch={watch} />}
                  <DeleteWatch watch={watch} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="mt-4 px-1 text-[13.5px] leading-5 text-muted-foreground">
          Want something else watched? Ask in the chat.
        </p>
      </div>
    </AuniSheet>
  );
}

/** Who watches it, then how it stands: "Prices, spoke up today". */
export function WatchState({ watch }: { readonly watch: AutomationWire }) {
  const by = watchSource(watch)?.name ?? watch.source;
  if (watch.status === "failed")
    return (
      <p className="mt-0.5 text-[13px] text-destructive">
        {by} stopped taking it. Ask me to set it up again.
      </p>
    );
  if (watch.status === "paused")
    return <p className="mt-0.5 text-[13px] text-muted-foreground">{by}, paused</p>;
  if (watch.lastFiredAt && isToday(watch.lastFiredAt))
    return <p className="mt-0.5 text-[13px] font-medium text-ink">{by}, spoke up today</p>;
  return (
    <p className="mt-0.5 text-[13px] text-muted-foreground">
      {watch.lastFiredAt
        ? `${by}, last spoke up ${spokeAt(watch.lastFiredAt)}`
        : `Watched by ${by}`}
    </p>
  );
}

function DeleteWatch({ watch }: { readonly watch: AutomationWire }) {
  const remove = useDeleteWatch();
  return (
    <button
      type="button"
      onClick={() => remove.mutate(watch.id)}
      aria-label={`Delete: ${watch.description}`}
      className="-mr-1.5 flex size-8 flex-none items-center justify-center rounded-full text-faint transition-colors hover:bg-foreground/[0.05] hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
    >
      <Trash2 aria-hidden className="size-4" />
    </button>
  );
}

function WatchSwitch({ watch }: { readonly watch: AutomationWire }) {
  const setPaused = useSetWatchPaused();
  return (
    <Switch
      checked={watch.status === "active"}
      onCheckedChange={(checked) => setPaused.mutate({ id: watch.id, paused: !checked })}
      aria-label={`${watch.status === "active" ? "Pause" : "Resume"}: ${watch.description}`}
      className="mt-0.5 flex-none"
    />
  );
}
