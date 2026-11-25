"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useDepositsSince, useRefreshMoney } from "@/components/portfolio/use-portfolio";
import { useMoney } from "@/components/money/money-provider";
import type { FundingNeed } from "@/lib/app-links";
import { markActivitySeen } from "@/lib/data/activity";

import { Portal } from "./portal";

/**
 * The Portal on the account's own addresses, showing every deposit core records after it opened,
 * a test send and the real one after it alike. `need` is what a card is short of, when one opened
 * it.
 */
export function DepositPortal({ need }: { readonly need: FundingNeed | null }) {
  const { depositNetworks: networks, portfolio } = useMoney();
  const landed = useDepositsSince();

  // The money is read again to show what landed. The owner watched it land, so Activity has
  // nothing new to tell them about it.
  const refreshMoney = useRefreshMoney();
  const queryClient = useQueryClient();
  const latest = landed[0]?.id ?? null;
  useEffect(() => {
    if (!latest) return;
    refreshMoney();
    void markActivitySeen().then(
      () => queryClient.invalidateQueries({ queryKey: ["activity"] }),
      () => undefined,
    );
  }, [latest, refreshMoney, queryClient]);

  return (
    <Portal
      feesPayable={portfolio?.feesPayable ?? null}
      landed={landed}
      need={need}
      networks={networks}
    />
  );
}
