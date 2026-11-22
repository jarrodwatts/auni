"use client";

import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useMe } from "@/components/personalization/use-me";
import { WithdrawDialog } from "@/components/withdraw/withdraw-dialog";
import { cn } from "@/lib/utils";

const ACTION =
  "flex h-9 items-center justify-center gap-1.5 rounded-full px-3.5 text-meta font-semibold transition-[background-color,transform] duration-200 ease-settle focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";

/** Money out, then money in, beside the total they change: adding money is the filled one, at the end. */
export function MoneyActions({ className }: { readonly className?: string }) {
  const { addMoneyHref } = useAppDialogs();
  const { wallets } = useMe();
  const [withdrawing, setWithdrawing] = useState(false);
  return (
    <div className={cn("gap-2", className)}>
      <button
        type="button"
        // Settings holds the same rule: nothing to withdraw from until the wallet exists.
        disabled={!wallets?.evm}
        onClick={() => setWithdrawing(true)}
        className={cn(ACTION, "bg-foreground/[0.05] text-ink hover:bg-foreground/[0.08]")}
      >
        <ArrowUpRight aria-hidden className="size-4" strokeWidth={2.4} />
        Withdraw
      </button>
      <Link
        href={addMoneyHref}
        scroll={false}
        className={cn(ACTION, "bg-foreground text-background hover:bg-foreground/85")}
      >
        <Plus aria-hidden className="size-4" strokeWidth={2.4} />
        Add money
      </Link>
      <WithdrawDialog open={withdrawing} onOpenChange={setWithdrawing} />
    </div>
  );
}
