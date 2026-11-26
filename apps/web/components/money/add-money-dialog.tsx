"use client";

import type { FundingNeed } from "@/lib/app-links";

import { MoneySheet } from "./money-sheet";
import { DepositPortal } from "./portal/deposit-portal";

/**
 * Money in: the Portal shows the wallet's addresses to send to from an exchange or another
 * wallet. `asked` is null while it's closed, and names what a card is short of when one opened it.
 */
export function AddMoneyDialog({
  asked,
  onOpenChange,
}: {
  readonly asked: { readonly need: FundingNeed | null } | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <MoneySheet open={asked !== null} onOpenChange={onOpenChange}>
      <DepositPortal need={asked?.need ?? null} />
    </MoneySheet>
  );
}
