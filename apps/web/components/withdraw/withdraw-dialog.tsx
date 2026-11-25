"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { useRefreshMoney } from "@/components/portfolio/use-portfolio";
import {
  AuniDialogMascot,
  auniDialogCardClass,
  auniDialogDescriptionClass,
  auniDialogOutlineButtonClass,
  auniDialogOverlayClass,
  auniDialogPrimaryButtonClass,
  auniDialogTitleClass,
} from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CoreApiError } from "@/lib/core";
import { decideAction, useLiveAction } from "@/lib/data/actions";
import {
  addressFits,
  proposeWithdrawal,
  cashWords,
  readWithdrawCash,
  sentWords,
  WITHDRAW_NETWORKS,
  type Withdrawal,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "@/lib/data/withdrawals";
import { formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

import { WithdrawReview } from "./withdraw-review";

const FIELD =
  "h-11 w-full rounded-control border border-foreground/[0.12] bg-background px-3.5 text-body text-ink outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/25";
const LABEL = "flex flex-col gap-1.5 text-meta font-medium text-muted-foreground";

type Step =
  | { readonly kind: "form" }
  | { readonly kind: "review"; readonly withdrawal: Withdrawal }
  | { readonly kind: "sent"; readonly withdrawal: Withdrawal };

/** Settings' Withdraw: dollars out to an exchange or the person's own wallet, confirmed step by step. */
export function WithdrawDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState<WithdrawDestination>("exchange");
  const [network, setNetwork] = useState<WithdrawNetwork>("base");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cash = useQuery({
    queryKey: ["withdraw-cash"],
    queryFn: ({ signal }) => readWithdrawCash(signal),
    enabled: open,
  });
  const max = cash.data?.maxUsd[network];
  // After Allow the withdrawal runs on its own; watch it until it settles.
  const sent = step.kind === "sent" ? step.withdrawal : null;
  const live = useLiveAction(sent?.action.id ?? null);
  const sentNow = sent ? (live.data ?? sent.action) : null;
  const settled = sentNow?.status === "done" || sentNow?.status === "failed";
  const refreshMoney = useRefreshMoney();
  useEffect(() => {
    if (settled) refreshMoney();
  }, [refreshMoney, settled]);

  const reset = () => {
    setStep({ kind: "form" });
    setAmount("");
    setAddress("");
    setError(null);
  };
  const close = () => {
    // A proposal left on the confirm step is declined, so nothing lingers waiting.
    if (step.kind === "review")
      void decideAction(step.withdrawal.action.id, "decline").catch(() => {});
    onOpenChange(false);
    reset();
  };

  const review = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const dollars = amount.replace(/[$,\s]/gu, "");
    if (!/^\d+(\.\d{1,2})?$/u.test(dollars) || Number(dollars) <= 0)
      return setError("Enter an amount in dollars, like 50 or 12.50.");
    if (max !== undefined && Number(dollars) > Number(max))
      return setError(`You can withdraw up to ${formatUsd(max)} here.`);
    if (!addressFits(network, address))
      return setError(
        network === "solana"
          ? "That isn't a Solana address. Copy it again."
          : "That isn't an address on this network. It starts with 0x and has 42 characters.",
      );
    setBusy(true);
    setError(null);
    try {
      const withdrawal = await proposeWithdrawal({
        amountUsd: dollars,
        network,
        address,
        destination,
      });
      setStep({ kind: "review", withdrawal });
    } catch (caught) {
      setError(
        caught instanceof CoreApiError && caught.detail
          ? caught.detail
          : "That didn't reach Auni. Nothing was sent, so try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const heading =
    sent && sentNow
      ? sentWords(sent, sentNow)
      : step.kind === "review"
        ? {
            title: "Check before it goes",
            lede: "Money sent to a wrong address can’t come back.",
          }
        : { title: "Withdraw", lede: "Send cash to an exchange or a wallet you own." };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className={cn(auniDialogCardClass, "max-h-[calc(100dvh-2rem)] overflow-y-auto")}
        overlayClassName={auniDialogOverlayClass}
      >
        <AuniDialogMascot
          state={sentNow && sentNow.status !== "failed" ? "celebrating" : "listening"}
        />
        <DialogHeader className="mt-3.5 items-center gap-0 text-center sm:text-center">
          <DialogTitle className={auniDialogTitleClass}>{heading.title}</DialogTitle>
          <DialogDescription className={auniDialogDescriptionClass}>
            {heading.lede}
          </DialogDescription>
        </DialogHeader>

        {step.kind === "review" ? (
          <div className="mt-5">
            <WithdrawReview
              withdrawal={step.withdrawal}
              onBack={() => {
                void decideAction(step.withdrawal.action.id, "decline").catch(() => {});
                setStep({ kind: "form" });
              }}
              onSent={(action) =>
                setStep({ kind: "sent", withdrawal: { ...step.withdrawal, action } })
              }
            />
          </div>
        ) : step.kind === "sent" ? (
          <Button
            className={cn(auniDialogPrimaryButtonClass, "mt-6")}
            onClick={close}
            type="button"
          >
            Done
          </Button>
        ) : (
          <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => void review(event)}>
            <label className={LABEL}>
              Amount
              <span className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-body text-muted-foreground">
                  $
                </span>
                <input
                  autoComplete="off"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className={cn(FIELD, "pr-16 pl-7 tabular-nums")}
                />
                <button
                  type="button"
                  disabled={!max || Number(max) <= 0}
                  onClick={() => max && setAmount(max)}
                  className="absolute top-1/2 right-1.5 h-8 -translate-y-1/2 rounded-full px-3 text-meta font-semibold text-primary hover:bg-foreground/[0.04] disabled:opacity-40"
                >
                  Max
                </button>
              </span>
              <span className="font-normal">
                {cash.data
                  ? cashWords(cash.data)
                  : cash.isError
                    ? "Your cash couldn’t load right now."
                    : "Reading your cash…"}
              </span>
            </label>

            <div role="radiogroup" aria-label="Where it goes" className="grid grid-cols-2 gap-2">
              {(
                [
                  ["exchange", "An exchange", "Like Coinbase"],
                  ["wallet", "My own wallet", "One you control"],
                ] as const
              ).map(([id, label, detail]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={destination === id}
                  onClick={() => setDestination(id)}
                  className={cn(
                    "rounded-control border px-3.5 py-2.5 text-left transition-colors",
                    destination === id
                      ? "border-foreground/40 bg-foreground/[0.03]"
                      : "border-foreground/[0.1] hover:bg-foreground/[0.02]",
                  )}
                >
                  <span className="block text-ui font-medium text-ink">{label}</span>
                  <span className="block text-meta text-muted-foreground">{detail}</span>
                </button>
              ))}
            </div>

            <label className={LABEL}>
              Network
              <select
                value={network}
                onChange={(event) => setNetwork(event.target.value as WithdrawNetwork)}
                className={cn(FIELD, "appearance-none")}
              >
                {WITHDRAW_NETWORKS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              {destination === "exchange" && network === "base" ? (
                <span className="font-normal">Coinbase takes USDC on Base.</span>
              ) : null}
            </label>

            <label className={LABEL}>
              {destination === "exchange" ? "Your exchange’s USDC address" : "Your wallet address"}
              <input
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={network === "solana" ? "Solana address" : "0x…"}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                className={cn(FIELD, "font-mono text-ui")}
              />
            </label>

            {error ? (
              <p role="alert" className="text-meta text-destructive">
                {error}
              </p>
            ) : null}

            <div className="mt-1 grid grid-cols-2 gap-3">
              <DialogClose asChild>
                <Button className={auniDialogOutlineButtonClass} disabled={busy} variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button className={auniDialogPrimaryButtonClass} disabled={busy} type="submit">
                {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                Review
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
