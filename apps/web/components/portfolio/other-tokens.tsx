"use client";

import { NETWORKS, type OtherTokensWire } from "@auni/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins } from "lucide-react";

import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { useRefreshSpecialists } from "@/components/specialist/use-specialists";
import { shortAddress } from "@/components/money/portal/deposit-addresses";
import { NetworkMark } from "@/components/money/portal/network-mark";
import {
  auniDialogCardClass,
  auniDialogDescriptionClass,
  auniDialogOverlayClass,
  auniDialogTitleClass,
} from "@/components/ui/auni-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  focusDialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { addToken, getOtherTokens } from "@/lib/data/portfolio";
import { cn } from "@/lib/utils";

import { otherTokenLine } from "./other-tokens-text";

type OtherToken = OtherTokensWire["tokens"][number];

/** Their mark among the holdings: a token with no name of its own to show. */
export function OtherTokensMark({ size }: { readonly size: number }) {
  return (
    <span
      aria-hidden
      className="flex flex-none items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground"
      style={{ width: size, height: size }}
    >
      <Coins className="size-[45%]" strokeWidth={2} />
    </span>
  );
}

/**
 * Tokens sent to their wallets that Auni neither recognises nor was told are
 * theirs. Anyone can send one, named and priced to look like money, so each
 * shows by its address alone, with what they hold and what a price feed says
 * that's worth, read only while this is open. Add makes one theirs.
 */
export function OtherTokensDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(auniDialogCardClass, "max-h-[calc(100dvh-2rem)] overflow-y-auto")}
        overlayClassName={auniDialogOverlayClass}
        onOpenAutoFocus={focusDialogTitle}
      >
        <DialogHeader className="gap-0">
          <DialogTitle className={auniDialogTitleClass}>Other tokens</DialogTitle>
          <DialogDescription className={auniDialogDescriptionClass}>
            Anyone can send a token to any wallet, so these aren&apos;t counted in your total. Add
            one you know is yours.
          </DialogDescription>
        </DialogHeader>
        {/* Read only while open: what they hold of each costs a read of its chain. */}
        {open ? <TokenList /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TokenList() {
  const tokens = useQuery({
    queryKey: ["other-tokens"],
    queryFn: ({ signal }) => getOtherTokens(signal),
  });
  if (tokens.isPending)
    return (
      <div className="mt-5 grid gap-2">
        <Skeleton className="h-14 rounded-[14px]" />
        <Skeleton className="h-14 rounded-[14px]" />
      </div>
    );
  if (!tokens.data)
    return (
      <p role="alert" className="mt-5 text-[14px] text-destructive">
        They couldn&apos;t be read just now. Try again in a moment.
      </p>
    );
  if (tokens.data.length === 0)
    return <p className="mt-5 text-[14px] text-muted-foreground">None right now.</p>;
  return (
    <ul className="mt-5 grid gap-2">
      {tokens.data.map((token) => (
        <TokenRow key={`${token.network}:${token.address}`} token={token} />
      ))}
    </ul>
  );
}

function TokenRow({ token }: { readonly token: OtherToken }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshSpecialists();
  const add = useMutation({
    mutationFn: () => addToken(token),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["other-tokens"] });
      refresh();
    },
  });
  const network = NETWORKS[token.network];
  return (
    <li className="flex items-center gap-3 rounded-[14px] bg-surface px-3.5 py-2.5">
      <NetworkMark network={network} size={28} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[13.5px] text-ink" title={token.address}>
          {shortAddress(token.address)}
        </p>
        <p className="truncate text-[12.5px] text-muted-foreground">
          {otherTokenLine(token, network.name)}
        </p>
      </div>
      <MoneyButton
        tone="outline"
        className="h-9 px-4 text-[13.5px]"
        busy={add.isPending}
        busyLabel="Adding"
        disabled={add.isPending}
        onClick={() => add.mutate()}
      >
        {add.isError ? "Try again" : "Add"}
      </MoneyButton>
    </li>
  );
}
