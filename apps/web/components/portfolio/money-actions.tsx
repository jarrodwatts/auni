"use client";

import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useMe } from "@/components/personalization/use-me";
import { Button, buttonVariants } from "@/components/ui/button";
import { WithdrawDialog } from "@/components/withdraw/withdraw-dialog";
import { cn } from "@/lib/utils";

/** Money out, then money in, beside the total they change: adding money is the filled one, at the end. */
export function MoneyActions({ className }: { readonly className?: string }) {
  const { addMoneyHref } = useAppDialogs();
  const { wallets } = useMe();
  const [withdrawing, setWithdrawing] = useState(false);
  return (
    <div className={cn("gap-2", className)}>
      <Button
        variant="secondary"
        // Settings holds the same rule: nothing to withdraw from until the wallet exists.
        disabled={!wallets?.evm}
        onClick={() => setWithdrawing(true)}
      >
        <ArrowUpRight aria-hidden />
        Withdraw
      </Button>
      <Link href={addMoneyHref} scroll={false} className={buttonVariants()}>
        <Plus aria-hidden />
        Add money
      </Link>
      <WithdrawDialog open={withdrawing} onOpenChange={setWithdrawing} />
    </div>
  );
}
