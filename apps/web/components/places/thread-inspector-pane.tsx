"use client";

import type { ThreadId } from "@auni/shared";
import { Laptop } from "lucide-react";
import { toast } from "sonner";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { AutonomyPicker } from "@/components/app/autonomy-picker";
import { useChangeThread, useThreads } from "@/components/app/use-threads";
import { useMe } from "@/components/personalization/use-me";
import { useThreadState } from "@/components/portfolio/use-portfolio";
import { Change } from "@/components/brand/marks";
import { Skeleton } from "@/components/ui/skeleton";
import type { Thread, ThreadState } from "@/lib/data/views";
import { changePercent, formatUsd, formatUsdcBalance, formatUsdcChange } from "@/lib/money";

import { PaneHoldings } from "./pane-holdings";
import { PaneNotes, PaneRecord, PaneWatches } from "./pane-sections";
import { takeValue } from "./use-takes";

/**
 * A chat's inspector, its take first: what it is worth and how that moved today, the positions
 * it holds, what it watches, what it may spend on its own, Auni's notes, and its moves.
 */
export function ThreadInspectorPane({ threadId }: { readonly threadId: ThreadId }) {
  const { threads } = useThreads();
  const thread = threads.find(({ id }) => id === threadId);
  if (!thread) return <PaneLoading />;
  return <ThreadDetails key={thread.id} thread={thread} />;
}

function ThreadDetails({ thread }: { readonly thread: Thread }) {
  const changeThread = useChangeThread();
  const state = useThreadState(thread.id);
  const holdings = state.data?.holdings ?? [];
  const take = takeValue(holdings);
  const hasContent =
    holdings.length > 0 || thread.watchCount > 0 || Boolean(thread.notes) || thread.moveCount > 0;

  return (
    <div className="flex min-h-full flex-col pt-6 pb-8">
      <div className="px-6">
        <h2 className="line-clamp-2 text-section text-ink lg:pr-8">{thread.title}</h2>
        {take ? (
          <div className="mt-3">
            <p className="text-card-money text-ink tabular-nums lining-nums">
              {formatUsdcBalance(take.value)}
            </p>
            {take.change === null ? null : (
              <p className="mt-0.5 text-ui tabular-nums lining-nums">
                <Change pct={changePercent(take.change, take.value)} period="today" />
                <span className="ml-1.5 text-muted-foreground">
                  {formatUsdcChange(take.change)} today
                </span>
              </p>
            )}
          </div>
        ) : null}
      </div>

      {holdings.length > 0 ? (
        <section aria-label="Positions" className="mt-6 px-6">
          <h3 className="mb-1 text-meta font-medium text-faint">Positions</h3>
          <PaneHoldings holdings={holdings} />
        </section>
      ) : null}

      <PaneWatches threadId={thread.id} />

      <section aria-label="Spending" className="mt-7 px-6">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-meta font-medium text-faint">Spending</h3>
          <AutonomyPicker
            actMode={thread.actMode}
            budgetUsd={thread.budgetUsd}
            freeBudgetUsd={state.data?.freeBudgetUsd ?? null}
            threadTitle={thread.title}
            onChange={(next) =>
              void changeThread(thread.id, next).catch(() =>
                toast.error(
                  "Couldn't save your spending setting. Your current setting is unchanged. Try again.",
                ),
              )
            }
          />
        </div>
        <SpendingLine thread={thread} state={state.data} />
      </section>

      <PaneNotes notes={thread.notes} />
      <PaneRecord thread={thread} />

      {!hasContent ? (
        <p className="mt-7 px-6 text-ui text-muted-foreground">
          Positions, watches, and notes for this take will appear here.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the chat may spend without asking: nothing (every move waits for a tap), or Auto's budget
 * as a bar of what's left. Watches and Auto stop while a computer that sleeps does, which is said
 * where it matters, once.
 */
function SpendingLine({
  thread,
  state,
}: {
  readonly thread: Thread;
  readonly state: ThreadState | undefined;
}) {
  const me = useMe();
  const { openSettings } = useAppDialogs();
  const auto = thread.actMode === "within_limits";
  const budget = Number(state?.budgetUsd ?? thread.budgetUsd);
  const sleeps = !me.reach.staysOn.stays && (auto || thread.watchCount > 0);

  return (
    <>
      {auto ? (
        <div className="mt-2">
          {/* What's left only once the state read says; the whole budget would claim none spent. */}
          {state ? (
            <BudgetLeft left={Number(state.freeBudgetUsd)} budget={budget} />
          ) : (
            <p className="text-ui text-muted-foreground tabular-nums lining-nums">
              {formatUsd(String(budget))} budget
            </p>
          )}
          <p className="mt-2 text-meta text-muted-foreground">
            Buys and sells inside this budget without asking. Perps, bridges, and withdrawals still
            ask.
          </p>
        </div>
      ) : (
        <p className="mt-1 text-ui text-muted-foreground">Every move waits for your tap.</p>
      )}
      {sleeps ? (
        <p className="mt-3 flex items-start gap-2 text-meta text-muted-foreground">
          <Laptop aria-hidden className="mt-0.5 size-3.5 flex-none" />
          <span>
            {auto && thread.watchCount > 0
              ? "Auto and watches pause"
              : auto
                ? "Auto pauses"
                : "Watches pause"}{" "}
            while {me.reach.machine} sleeps.{" "}
            <button
              type="button"
              onClick={() => openSettings("machine")}
              className="auni-text-link font-medium"
            >
              Keep running 24/7
            </button>
          </span>
        </p>
      ) : null}
    </>
  );
}

/** Auto's budget as what's left of it, in words and as an ink bar. */
function BudgetLeft({ left, budget }: { readonly left: number; readonly budget: number }) {
  const leftPct = budget > 0 ? Math.max(0, Math.min(100, (left / budget) * 100)) : 0;
  return (
    <>
      <p className="text-ui text-ink tabular-nums lining-nums">
        {formatUsd(String(left))}{" "}
        <span className="text-muted-foreground">of {formatUsd(String(budget))} left</span>
      </p>
      <div
        aria-hidden
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
      >
        <div
          className="h-full rounded-full bg-ink transition-[width] duration-300 ease-settle"
          style={{ width: `${leftPct}%` }}
        />
      </div>
    </>
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
