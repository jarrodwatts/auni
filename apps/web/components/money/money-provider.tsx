"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { useMe } from "@/components/personalization/use-me";
import { usePortfolio } from "@/components/portfolio/use-portfolio";
import { depositNetworks, type DepositNetwork, type Portfolio } from "@/lib/data/portfolio";

interface MoneyContextValue {
  /** Null until the first read lands, or when it failed. */
  readonly portfolio: Portfolio | null;
  readonly loading: boolean;
  /** Every network money can arrive on from another wallet, each with its own address. */
  readonly depositNetworks: readonly DepositNetwork[];
  /**
   * Something on screen waits for money, as the Portal does while it's open: the money is read
   * more often until the release this returns is called.
   */
  readonly watchDeposits: () => () => void;
}

const MoneyContext = createContext<MoneyContextValue | null>(null);

export function useMoney(): MoneyContextValue {
  const context = useContext(MoneyContext);
  if (!context) throw new Error("useMoney must be used inside MoneyProvider");
  return context;
}

export function MoneyProvider({ children }: { readonly children: ReactNode }) {
  const { wallets } = useMe();
  // How many screens open now are waiting for money; each reads it more often while open.
  const [watching, setWatching] = useState(0);
  const portfolioQuery = usePortfolio(watching > 0);
  const portfolio = portfolioQuery.data ?? null;

  const watchDeposits = useCallback(() => {
    setWatching((count) => count + 1);
    return () => setWatching((count) => count - 1);
  }, []);

  const evmAddress = wallets?.evm ?? null;
  const solanaAddress = wallets?.solana ?? null;
  const networks = useMemo(
    () => depositNetworks({ evm: evmAddress, solana: solanaAddress }),
    [evmAddress, solanaAddress],
  );

  const value = useMemo<MoneyContextValue>(
    () => ({
      loading: portfolioQuery.isPending,
      portfolio,
      depositNetworks: networks,
      watchDeposits,
    }),
    [networks, portfolio, portfolioQuery.isPending, watchDeposits],
  );

  return <MoneyContext value={value}>{children}</MoneyContext>;
}
