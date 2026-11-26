"use client";

import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ME_KEY } from "@/components/personalization/use-me";
import {
  UNTIL_ANSWERED,
  useDepositWatch,
  useRefreshMoney,
} from "@/components/portfolio/use-portfolio";
import { useMoney } from "@/components/money/money-provider";
import type { FundingNeed } from "@/lib/app-links";
import { markActivitySeen } from "@/lib/data/activity";
import { makeWallet } from "@/lib/data/me";

import { Portal } from "./portal";

/**
 * The ask that makes the owner's wallet while there's none to send to, as when their first take
 * couldn't make it: one ask however many sheets are open, asked until it's made, and core makes
 * one wallet however many ask (see makeWalletIfNone). Its answer is the owner as they are now,
 * so the address shows the moment it's made.
 */
export const walletMadeQuery = queryOptions({
  queryKey: ["wallet-made"],
  // Closing the sheet doesn't stop a wallet being made.
  queryFn: async ({ client }) => {
    const me = await makeWallet();
    client.setQueryData(ME_KEY, me);
    return me;
  },
  ...UNTIL_ANSWERED,
});

/**
 * The Portal on the account's own addresses, showing every deposit core records after it opened
 * (never one from before), a test send and the real one after it alike. `need` is what a card is
 * short of, when one opened it.
 */
export function DepositPortal({ need }: { readonly need: FundingNeed | null }) {
  const { depositNetworks, portfolio } = useMoney();
  const { watching, landed } = useDepositWatch();
  useQuery({ ...walletMadeQuery, enabled: depositNetworks.length === 0 });

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
      networks={depositNetworks}
      watching={watching}
    />
  );
}
