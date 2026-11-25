"use client";

import { ArrowRight, Eye, Zap } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { ThreadFailureNotice } from "@/components/app/thread-failure-notice";
import { useStartNew } from "@/components/app/use-start-conversation";
import { Mascot } from "@/components/brand/mascot";
import { useMoney } from "@/components/money/money-provider";
import { PlaceLink } from "@/components/places/open-place";
import { PlaceHeader } from "@/components/places/place-header";
import { PortfolioMark } from "@/components/places/place-marks";
import { usePlaces } from "@/components/places/use-places";
import { usePortfolio } from "@/components/portfolio/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";
import { chatHref } from "@/lib/app-links";
import { cn } from "@/lib/utils";

import { AskAuni } from "./ask-auni";
import { CashTiles, HoldingTiles } from "./cash-tiles";
import { CashRows, HoldingRows } from "./money-rows";
import { NeedsYou } from "./needs-you";
import { PortfolioSection } from "./portfolio-section";
import { TotalHero } from "./total-hero";

const READ_FAILURE = { message: "Your portfolio couldn't load.", action: "reload" } as const;
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3";

/**
 * Portfolio is the flat live view of all your money: total and chart, any
 * decisions waiting on you, live Holdings, Cash, and any Auto/watching threads.
 */
export function PortfolioScreen() {
  const money = useMoney();
  const portfolio = usePortfolio();
  const failed = portfolio.isError && !portfolio.data;
  const empty = money.portfolio?.empty === true;
  const loading = money.loading;
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
  const { chats, pinned, active } = usePlaces();
  const portfolio = useMoney().portfolio;
  const holdings = portfolio?.holdings ?? [];
  const workingThreads = [...pinned, ...active].filter(
    ({ thread }) => thread.actMode === "within_limits" || thread.watchCount > 0,
  );

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
          <NeedsYou chats={chats} className="max-sm:order-first" />

          <PortfolioSection title="Holdings">
            {holdings.length > 0 ? (
              <>
                <div className="sm:hidden">
                  <HoldingRows holdings={holdings} />
                </div>
                <HoldingTiles holdings={holdings} className={`${GRID} max-sm:hidden`} />
              </>
            ) : (
              <p className="text-ui font-normal text-muted-foreground">
                Tell Auni what you believe in a <NewChatLink>new thread</NewChatLink>, and any
                positions you open will show here.
              </p>
            )}
          </PortfolioSection>

          {portfolio ? (
            <PortfolioSection title="Cash">
              <div className="sm:hidden">
                <CashRows cash={portfolio.cash} otherTokens={portfolio.otherTokens} />
              </div>
              <CashTiles
                cash={portfolio.cash}
                otherTokens={portfolio.otherTokens}
                className={`${GRID} max-sm:hidden`}
              />
            </PortfolioSection>
          ) : null}

          {workingThreads.length > 0 ? (
            <PortfolioSection title="Active threads">
              <ul className={GRID}>
                {workingThreads.map(({ thread }) => {
                  const auto = thread.actMode === "within_limits";
                  const budget = Number(thread.budgetUsd);
                  const budgetLabel =
                    Number.isFinite(budget) && budget > 0
                      ? `$${budget.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                      : "";
                  return (
                    <li key={thread.id}>
                      <PlaceLink
                        href={chatHref(thread.id)}
                        thread={thread.id}
                        className="flex min-w-0 items-center gap-3 rounded-card bg-surface px-3.5 py-3 transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        <span
                          className={cn(
                            "flex size-8 flex-none items-center justify-center rounded-full",
                            "bg-glyph-plate",
                            auto ? "text-primary" : "text-muted-foreground",
                          )}
                        >
                          {auto ? (
                            <Zap aria-hidden className="size-4" />
                          ) : (
                            <Eye aria-hidden className="size-4" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body font-medium text-ink">{thread.title}</p>
                          <p className="mt-0.5 truncate text-caption font-medium text-muted-foreground">
                            {auto
                              ? `Auto ${budgetLabel} budget`
                              : thread.watchCount === 1
                                ? "1 watch active"
                                : `${thread.watchCount} watches active`}
                          </p>
                        </div>
                      </PlaceLink>
                    </li>
                  );
                })}
              </ul>
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
      <h2 className="mt-5 text-title text-ink">Your portfolio starts with a belief</h2>
      <p className="mt-2 max-w-[380px] text-ui leading-[1.5] font-normal text-muted-foreground">
        Tell Auni something you believe about the world, and the positions you open will live here.
      </p>
      <Link
        href="/app/new"
        onClick={startNew}
        className="mt-7 flex h-10 items-center gap-1.5 rounded-full bg-foreground px-5 text-ui font-semibold text-background transition-[background-color,transform] duration-200 ease-settle hover:bg-foreground/85 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97]"
      >
        New thread
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
      <Skeleton className="h-4 w-24 rounded-control" />
      <Skeleton className="mt-2 h-14 w-64 rounded-card" />
      <Skeleton className="mt-6 h-[140px] w-full rounded-card" />
      <Skeleton className="mt-10 h-[192px] rounded-card sm:hidden" />
      <div className={`mt-10 ${GRID} max-sm:hidden`}>
        <Skeleton className="h-[74px] rounded-card" />
        <Skeleton className="h-[74px] rounded-card" />
        <Skeleton className="h-[74px] rounded-card" />
      </div>
    </div>
  );
}
