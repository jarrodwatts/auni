"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useRefreshMoney } from "@/components/portfolio/use-portfolio";
import { useMoney } from "@/components/money/money-provider";
import { markActivitySeen } from "@/lib/data/activity";

import { NOT_WATCHED, watchRead, type DepositWatch } from "../deposit-watch";
import { Portal } from "./portal";

/**
 * The Portal on the account's own addresses, reading the money more often for as long as it's
 * open, and showing every deposit core records after it opened. `need` is the whole dollars
 * a card asked for, when one opened it.
 */
export function DepositPortal({ need }: { readonly need: string | null }) {
  const { depositNetworks: networks, portfolio, watchDeposits } = useMoney();
  useEffect(() => watchDeposits(), [watchDeposits]);

  // Deposits recorded already are old news, taken as seen from the money as it was last read.
  const [watch, setWatch] = useState<DepositWatch>(NOT_WATCHED);
  if (portfolio) {
    const read = watchRead(watch, portfolio.deposits);
    if (read !== watch) setWatch(read);
  }

  // The portfolio read already holds what landed; the reads around it, such as history, don't.
  // The owner watched it land, so Activity has nothing new to tell them about it.
  const refreshMoney = useRefreshMoney();
  const queryClient = useQueryClient();
  const { landed } = watch;
  const latest = landed[0]?.id ?? null;
  useEffect(() => {
    if (!latest) return;
    refreshMoney();
    void markActivitySeen().then(
      () => queryClient.invalidateQueries({ queryKey: ["activity"] }),
      () => undefined,
    );
  }, [latest, refreshMoney, queryClient]);

  return <Portal landed={landed} need={need} networks={networks} />;
}
