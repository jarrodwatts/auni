"use client";

import type { ActivityItemWire, ThreadId } from "@auni/shared";
import Link from "next/link";
import { useState } from "react";

import { ActivityReceipt } from "@/components/activity/activity-receipt";
import { useActivity } from "@/components/activity/use-activity";
import { useAppDialogs } from "@/components/app/app-dialogs";
import { ThreadFailureNotice } from "@/components/app/thread-failure-notice";
import { useStartNew } from "@/components/app/use-start-conversation";
import { useMoney } from "@/components/money/money-provider";
import { PlaceHeader } from "@/components/places/place-header";
import { PortfolioMark } from "@/components/places/place-marks";
import { usePlaces } from "@/components/places/use-places";
import { AuniSheet } from "@/components/ui/auni-sheet";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import { CashGroup, OtherHoldings } from "./holding-groups";
import { moneyView } from "./money-groups";
import { Recent } from "./recent";
import { TotalHero } from "./total-hero";
import { usePortfolio, useTakes } from "./use-portfolio";
import { YourTakes } from "./your-takes";

const READ_FAILURE = {
  message: "Couldn't load your balances. Your money is untouched.",
  action: "reload",
} as const;
const COLUMN = "mx-auto w-full max-w-[760px] px-4 sm:px-8";

/**
 * Money: everything the owner has, in the order they think of it. The total and its line, then
 * each take with what it holds and the moves that built it, then cash, then what no take holds,
 * then every move as a receipt, even at a zero balance: only an owner with no past at all sees
 * the first-use prompt instead. A receipt opens over the page, from the right on a wide screen
 * and from the bottom on a phone.
 */
export function MoneyScreen({ openTake }: { readonly openTake: ThreadId | null }) {
  const money = useMoney();
  const portfolio = usePortfolio();
  const activity = useActivity();
  const failed = portfolio.isError && !portfolio.data;
  const view = moneyView(
    money.portfolio?.empty === true,
    activity.isError && !activity.data ? null : activity.data?.items,
  );
  const [loadedOnArrival] = useState(!money.loading);
  const reveal = !loadedOnArrival;
  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col">
      <PlaceHeader root icon={<PortfolioMark size={20} />} title="Money" />
      {failed ? (
        <div className={cn(COLUMN, "pt-6")}>
          <ThreadFailureNotice failure={READ_FAILURE} onRetry={() => void portfolio.refetch()} />
        </div>
      ) : money.loading || view === "waiting" ? (
        <MoneyLoading />
      ) : view === "first-use" ? (
        <NothingYet reveal={reveal} />
      ) : (
        <Overview reveal={reveal} openTake={openTake} activity={activity} />
      )}
    </section>
  );
}

function Overview({
  reveal,
  openTake,
  activity,
}: {
  readonly reveal: boolean;
  readonly openTake: ThreadId | null;
  readonly activity: ReturnType<typeof useActivity>;
}) {
  const takes = useTakes();
  const { chats, archived } = usePlaces();
  const [receipt, setReceipt] = useState<ActivityItemWire | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const roomy = useMediaQuery("(min-width: 1024px)");
  const items = activity.data?.items ?? [];
  const titles = new Map([...chats, ...archived].map(({ thread }) => [thread.id, thread.title]));
  const thread = receipt?.threadId
    ? { id: receipt.threadId, title: titles.get(receipt.threadId) ?? "Untitled take" }
    : undefined;
  const open = (item: ActivityItemWire) => {
    setReceipt(item);
    setSheetOpen(true);
  };

  return (
    <div data-money-scroller className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          COLUMN,
          "flex flex-col gap-10 pt-6 pb-16 sm:gap-12",
          reveal && "auni-stagger-in",
        )}
      >
        <TotalHero />
        <YourTakes
          takes={takes.data?.takes ?? null}
          failed={takes.isError && !takes.data}
          moves={items}
          openTake={openTake}
          onOpenMove={open}
        />
        <CashGroup places={takes.data?.cash ?? []} />
        <OtherHoldings loose={takes.data?.loose ?? []} />
        <Recent activity={activity} onOpen={open} />
      </div>
      {receipt ? (
        <AuniSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          side={roomy ? "right" : "bottom"}
          title={receipt.title}
        >
          <div className="auni-scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            <ActivityReceipt key={receipt.id} item={receipt} thread={thread} />
          </div>
        </AuniSheet>
      ) : null}
    </div>
  );
}

/** Nothing anywhere yet: where money and takes will show, and the two ways it starts. */
function NothingYet({ reveal }: { readonly reveal: boolean }) {
  const startNew = useStartNew();
  const { addMoneyHref } = useAppDialogs();
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-16 text-center",
        reveal && "auni-stagger-in",
      )}
    >
      <h2 className="text-title text-ink">No money here yet</h2>
      <p className="mt-2 max-w-[380px] text-ui text-muted-foreground">
        Add cash to your wallet or start a take. Your positions will group by take, with every move
        saved as a receipt.
      </p>
      <div className="mt-6 flex gap-2">
        <Link href="/app/new" onClick={startNew} className={buttonVariants()}>
          New take
        </Link>
        <Link
          href={addMoneyHref}
          scroll={false}
          className={buttonVariants({ variant: "secondary" })}
        >
          Add money
        </Link>
      </div>
    </div>
  );
}

function MoneyLoading() {
  return (
    <div className={cn(COLUMN, "auni-appear-late pt-6")}>
      <Skeleton className="h-4 w-24 rounded-control" />
      <Skeleton className="mt-2 h-14 w-64 rounded-card" />
      <Skeleton className="mt-6 h-[140px] w-full rounded-card" />
      <Skeleton className="mt-12 h-5 w-28 rounded-control" />
      <Skeleton className="mt-3 h-[208px] w-full rounded-card" />
    </div>
  );
}
