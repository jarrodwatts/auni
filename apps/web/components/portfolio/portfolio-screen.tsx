"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { ThreadFailureNotice } from "@/components/app/thread-failure-notice";
import { useStartNew } from "@/components/app/use-start-conversation";
import { Mascot } from "@/components/brand/mascot";
import { useSpecialists, usePortfolio } from "@/components/specialist/use-specialists";
import { useMoney } from "@/components/money/money-provider";
import { PlaceHeader } from "@/components/places/place-header";
import { PortfolioMark } from "@/components/places/place-marks";
import { usePlaces } from "@/components/places/use-places";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { AskAuni } from "./ask-auni";
import { CashTiles } from "./cash-tiles";
import { SpecialistTile } from "./specialist-tile";
import { SpecialistRows, LooseRows } from "./money-rows";
import { NeedsYou } from "./needs-you";
import { PortfolioSection } from "./portfolio-section";
import { TotalHero } from "./total-hero";

/** Shown in place of the page: a failed read must never look like an empty account. */
const READ_FAILURE = { message: "Your portfolio couldn't load.", action: "reload" } as const;

/** Tiles and cash share one set of columns: up to four across, one on a phone. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3";

/**
 * Portfolio is the overview of all your money, not a conversation, and it
 * fits on one screen: the total and its line, any decision waiting on you,
 * each specialist as a tile, then cash. Starting something happens in
 * a new chat, which is where an account with nothing yet is pointed.
 */
export function PortfolioScreen() {
  const money = useMoney();
  const specialists = useSpecialists();
  // The same cached read the money provider holds; here only for whether it failed.
  const portfolio = usePortfolio();
  const failed =
    (specialists.isError && !specialists.data) || (portfolio.isError && !portfolio.data);
  // Retired ones, in the sidebar's History, hold nothing, so they don't count here.
  const empty =
    money.portfolio?.empty && specialists.data?.every(({ status }) => status === "retired");
  const loading = money.loading || specialists.isPending;
  // Content that was already here simply shows; only content that had to load rises in.
  const [loadedOnArrival] = useState(!loading);
  const reveal = !loadedOnArrival;
  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-col">
      <PlaceHeader root icon={<PortfolioMark size={20} />} title="Portfolio" />
      {failed ? (
        <div className="mx-auto w-full max-w-[960px] px-4 pt-6 sm:px-8">
          <ThreadFailureNotice
            failure={READ_FAILURE}
            onRetry={() => {
              if (specialists.isError) void specialists.refetch();
              if (portfolio.isError) void portfolio.refetch();
            }}
          />
        </div>
      ) : loading ? (
        <PortfolioLoading />
      ) : empty ? (
        <NothingYet reveal={reveal} />
      ) : (
        <Overview reveal={reveal} />
      )}
    </section>
  );
}

function Overview({ reveal }: { readonly reveal: boolean }) {
  const { specialists, chats, waiting } = usePlaces();
  // Retired ones stay in the sidebar's History until archived; here are only where the money is.
  const open = specialists.filter(({ specialist }) => specialist.status !== "retired");
  const loose = useMoney().portfolio?.loose;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex w-full max-w-[960px] flex-col gap-8 px-4 pt-6 pb-28 sm:px-8 lg:pb-16",
            reveal && "auni-stagger-in",
          )}
        >
          <TotalHero />
          {/* On a phone what waits on the person leads the page, above the total. */}
          <NeedsYou
            specialists={specialists}
            chats={chats}
            waiting={waiting}
            className="max-sm:order-first"
          />
          <PortfolioSection title="Specialists">
            {open.length > 0 ? (
              <>
                <div className="sm:hidden">
                  <SpecialistRows places={open} />
                </div>
                <div className={`${GRID} auto-rows-fr max-sm:hidden`}>
                  {open.map(({ specialist, waiting: waits }) => (
                    <SpecialistTile key={specialist.id} specialist={specialist} waiting={waits} />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-ui font-normal text-muted-foreground">
                Tell Auni something you believe, or a job you’d like done, in a{" "}
                <NewChatLink>new chat</NewChatLink>, and it can start a specialist for it.
              </p>
            )}
          </PortfolioSection>
          {loose ? (
            <PortfolioSection
              title={
                loose.other.length > 0 || loose.otherTokens > 0 ? "Cash and other holdings" : "Cash"
              }
            >
              <div className="sm:hidden">
                <LooseRows loose={loose} />
              </div>
              <CashTiles loose={loose} className={`${GRID} max-sm:hidden`} />
            </PortfolioSection>
          ) : null}
        </div>
      </div>
      <AskAuni />
    </>
  );
}

function NewChatLink({ children }: { readonly children: ReactNode }) {
  const startNew = useStartNew();
  return (
    <Link href="/app/new" onClick={startNew} className="auni-text-link">
      {children}
    </Link>
  );
}

/** An account with nothing yet: where its money will be, and the one way to begin. */
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
      <Mascot alt="" size={72} state="color" />
      <h2 className="mt-5 text-amount tracking-[-0.02em] text-ink">
        Your portfolio starts with a belief
      </h2>
      <p className="mt-2 max-w-[380px] text-ui leading-[1.5] font-normal text-muted-foreground">
        Tell Auni something you believe about the world, and the portfolio it builds will live here.
      </p>
      <Link
        href="/app/new"
        onClick={startNew}
        className="mt-7 flex h-10 items-center gap-1.5 rounded-full bg-foreground px-5 text-ui font-semibold text-background transition-[background-color,transform] duration-200 ease-settle hover:bg-foreground/85 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97]"
      >
        New chat
        <ArrowRight aria-hidden className="size-4" strokeWidth={2.4} />
      </Link>
      <Link href={addMoneyHref} scroll={false} className="auni-text-link mt-4 text-meta">
        Add money first
      </Link>
    </div>
  );
}

function PortfolioLoading() {
  return (
    <div className="auni-appear-late mx-auto w-full max-w-[960px] px-4 pt-6 sm:px-8">
      <Skeleton className="h-4 w-24 rounded-md" />
      <Skeleton className="mt-2 h-14 w-64 rounded-lg" />
      <Skeleton className="mt-6 h-[140px] w-full rounded-card" />
      <Skeleton className="mt-10 h-[192px] rounded-[20px] sm:hidden" />
      <div className={`mt-10 ${GRID} max-sm:hidden`}>
        <Skeleton className="h-[150px] rounded-[20px]" />
        <Skeleton className="h-[150px] rounded-[20px]" />
        <Skeleton className="h-[150px] rounded-[20px]" />
      </div>
    </div>
  );
}
