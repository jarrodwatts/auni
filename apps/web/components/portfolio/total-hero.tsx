"use client";

import { useMoney } from "@/components/money/money-provider";
import { formatUsdcBalance } from "@/lib/money";

import { BalanceChart } from "./balance-chart";
import { BigMoney } from "./big-money";
import { ChartChange } from "./chart-change";
import { AUNI_HUE } from "./dawn-chart";
import { MoneyActions } from "./money-actions";
import { RangePicker } from "./range-picker";
import { useChartWindow, useLiveEnd } from "./use-chart-window";

/**
 * Your money: the total with the ways in and out beside it, how far it moved
 * over the period with the period picker at its end, and its Dawn line. On a
 * phone the line runs edge to edge, the actions share a row under the move,
 * and the periods take their own row under the line.
 */
export function TotalHero() {
  const { portfolio } = useMoney();
  const chart = useChartWindow(useLiveEnd(portfolio?.totalUsd, portfolio?.made));
  const latest = chart.points.at(-1)?.totalUsd;
  const total = portfolio
    ? BigInt(portfolio.totalUsd.baseUnits)
    : latest
      ? BigInt(latest.baseUnits)
      : null;
  const shown = total === null ? null : (chart.scrub?.baseUnits ?? total);
  const move = chart.move;
  const partial = portfolio?.partial === true;
  const looking = portfolio?.looking === true;

  const picker = (className: string) => (
    <RangePicker
      ranges={chart.ranges}
      value={chart.range}
      onChange={chart.setRange}
      className={className}
    />
  );

  return (
    <section aria-label="Your money">
      <p className="text-meta text-muted-foreground">Your money</p>
      <div className="flex items-center justify-between gap-6">
        {shown === null ? (
          <p className="mt-2 text-ui font-normal text-muted-foreground">
            Couldn&apos;t load your balance. Your money is untouched.
          </p>
        ) : (
          <BigMoney value={formatUsdcBalance(shown)} className="mt-1 min-w-0" />
        )}
        <MoneyActions className="flex flex-none max-sm:hidden" />
      </div>
      {/* The periods stay while any are offered, so an empty one can be left for one that isn't. */}
      {shown !== null && (partial || looking || move || chart.ranges.length > 1) ? (
        <div className="mt-1 flex items-center justify-between gap-4">
          {/* A total missing a source would show a drop that didn't happen. */}
          {partial ? (
            <p className="text-meta text-muted-foreground">
              Some balances couldn&apos;t load, so this total may be lower than what you hold.
            </p>
          ) : looking ? (
            <p className="text-meta text-muted-foreground">
              Checking your wallet for balances. More may appear as it finishes.
            </p>
          ) : move ? (
            <ChartChange move={move} label={chart.label} />
          ) : null}
          {picker("max-sm:hidden")}
        </div>
      ) : null}
      <MoneyActions className="mt-4 grid grid-cols-2 sm:hidden" />
      <BalanceChart
        points={chart.points}
        label="Your money"
        height={140}
        hue={AUNI_HUE}
        onScrub={chart.setScrub}
        className="mt-4 max-sm:-mx-4"
      />
      {picker("mt-3 sm:hidden")}
    </section>
  );
}
