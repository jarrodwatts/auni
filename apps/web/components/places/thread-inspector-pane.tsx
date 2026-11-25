"use client";

import type { ThreadId } from "@auni/shared";
import { Laptop, Zap } from "lucide-react";
import { toast } from "sonner";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { AutonomyPicker } from "@/components/app/autonomy-picker";
import { useChangeThread, useThreads } from "@/components/app/use-threads";
import { useMe } from "@/components/personalization/use-me";
import { useThreadState } from "@/components/portfolio/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";
import type { Thread } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";

import { PaneHoldings } from "./pane-holdings";
import { PaneNotes, PaneRecord, PaneWatches } from "./pane-sections";

function formatUsdCompact(usd: string): string {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;
}

/**
 * Right-hand inspector for any thread: permissions and auto-spend budget bar,
 * positions opened in this thread, active watches, working notes, and recent
 * thread activity.
 */
export function ThreadInspectorPane({ threadId }: { readonly threadId: ThreadId }) {
  const { threads } = useThreads();
  const thread = threads.find(({ id }) => id === threadId);
  if (!thread) return <PaneLoading />;
  return <ThreadDetails key={thread.id} thread={thread} />;
}

function ThreadDetails({ thread }: { readonly thread: Thread }) {
  const me = useMe();
  const { openSettings } = useAppDialogs();
  const changeThread = useChangeThread();
  const state = useThreadState(thread.id);
  const holdings = state.data?.holdings ?? [];
  const totalBaseUnits = holdings.reduce(
    (sum, holding) => sum + BigInt(holding.value.baseUnits),
    0n,
  );
  const auto = thread.actMode === "within_limits";
  const budget = Number(state.data?.budgetUsd ?? thread.budgetUsd);
  const free = Number(state.data?.freeBudgetUsd ?? thread.budgetUsd);
  const spent = Math.max(0, budget - free);
  const usedPct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const alwaysOn = me.reach.staysOn.stays;
  const needsAlwaysOn = auto || thread.watchCount > 0;
  const hasContent =
    holdings.length > 0 || thread.watchCount > 0 || Boolean(thread.notes) || thread.moveCount > 0;

  return (
    <div className="flex min-h-full flex-col pt-6 pb-8">
      <div className="px-6">
        <p className="text-meta font-medium text-faint">Thread details</p>
        <h2 className="mt-1 line-clamp-2 text-section text-ink lg:pr-8">{thread.title}</h2>

        <div className="mt-4 rounded-card border border-foreground/[0.08] bg-card p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-meta font-medium text-muted-foreground">Permissions</span>
            <AutonomyPicker
              actMode={thread.actMode}
              budgetUsd={thread.budgetUsd}
              freeBudgetUsd={state.data?.freeBudgetUsd ?? null}
              threadTitle={thread.title}
              onChange={(next) =>
                void changeThread(thread.id, next).catch(() =>
                  toast.error("That permission change couldn't be saved. Try again."),
                )
              }
            />
          </div>

          {auto ? (
            <div className="mt-3">
              <div className="flex items-baseline justify-between gap-2 text-meta tabular-nums">
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  <Zap aria-hidden className="size-3.5 text-primary" />
                  {formatUsdCompact(state.data?.freeBudgetUsd ?? thread.budgetUsd)} remaining
                </span>
                <span className="text-muted-foreground">
                  of {formatUsdCompact(state.data?.budgetUsd ?? thread.budgetUsd)} budget
                </span>
              </div>
              <div
                aria-hidden
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-settle"
                  style={{ width: `${usedPct}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="mt-2 text-meta leading-[1.45] text-muted-foreground">
              Every move in this thread waits for your tap on a card.
            </p>
          )}

          {!alwaysOn && needsAlwaysOn ? (
            <div className="mt-3 flex items-start gap-2 rounded-control bg-surface px-2.5 py-2 text-caption leading-[1.45] text-ink-soft">
              <Laptop aria-hidden className="mt-0.5 size-3.5 flex-none" />
              <span>
                Running locally on {me.reach.machine}. Watches and Auto moves pause while this
                computer sleeps.{" "}
                <button
                  type="button"
                  onClick={() => openSettings("remote")}
                  className="font-medium underline underline-offset-2"
                >
                  Keep running 24/7
                </button>
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {holdings.length > 0 ? (
        <section aria-label="Positions opened here" className="mt-7 px-6">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h3 className="text-meta font-medium text-faint">Positions opened here</h3>
            <span className="text-ui font-semibold text-ink tabular-nums">
              {formatUsdcBalance(totalBaseUnits)}
            </span>
          </div>
          <PaneHoldings holdings={holdings} />
        </section>
      ) : null}

      <PaneWatches threadId={thread.id} />
      <PaneNotes notes={thread.notes} />
      <PaneRecord thread={thread} />

      {!hasContent ? (
        <p className="mt-7 px-6 text-ui leading-[1.5] text-muted-foreground">
          Positions opened in this thread, watches, working notes, and recent activity show up here
          as you go.
        </p>
      ) : null}
    </div>
  );
}

function PaneLoading() {
  return (
    <div className="auni-appear-late flex flex-col px-6 pt-6">
      <Skeleton className="h-3.5 w-24 rounded-control" />
      <Skeleton className="mt-2 h-5 w-52 rounded-control" />
      <Skeleton className="mt-4 h-24 w-full rounded-card" />
      <Skeleton className="mt-6 h-12 w-full rounded-card" />
    </div>
  );
}
