"use client";

import { NETWORKS } from "@auni/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, LoaderCircle, Plus, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { NetworkPicker } from "@/components/money/network-picker";
import { MoneySheet } from "@/components/money/money-sheet";
import { NetworkMark } from "@/components/money/portal/network-mark";
import { shortAddress } from "@/components/money/portal/deposit-addresses";
import { useRefreshMoney } from "@/components/portfolio/use-portfolio";
import { AuniDialogMascot, auniDialogPrimaryButtonClass } from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Row, Rows } from "@/components/ui/row";
import { CoreApiError } from "@/lib/core";
import { decideAction, useLiveAction } from "@/lib/data/actions";
import {
  addressFits,
  cashWords,
  proposeWithdrawal,
  readWithdrawCash,
  sentWords,
  WITHDRAW_NETWORKS,
  type RecentPlace,
  type Withdrawal,
  type WithdrawDestination,
  type WithdrawNetwork,
} from "@/lib/data/withdrawals";
import { formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

import { WithdrawReview } from "./withdraw-review";

type Step =
  | { readonly kind: "form" }
  | { readonly kind: "review"; readonly withdrawal: Withdrawal }
  | { readonly kind: "sent"; readonly withdrawal: Withdrawal };

/** Where the money goes: a place it went before, or one typed in now. */
type To = { readonly kind: "recent"; readonly place: RecentPlace } | { readonly kind: "new" };

const CHIPS = WITHDRAW_NETWORKS.map(({ id, name }) => ({
  key: id,
  name,
  logo: NETWORKS[id].logo,
}));

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/**
 * Withdraw: dollars out to an exchange or a wallet, in one sheet. How much first, then where: a
 * place it went before (which takes no proof again), or a new address on a network picked as
 * chips. Review then shows the whole route, and the tap that sends it. Wherever it's opened
 * (Money, Settings, search), it's this sheet.
 */
export function WithdrawDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState<To | null>(null);
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
  const recent = cash.data?.recent ?? [];
  // The latest place is picked to start with, once it's read; else a new address.
  const chosen: To = to ?? (recent[0] ? { kind: "recent", place: recent[0] } : { kind: "new" });
  const goesTo =
    chosen.kind === "recent"
      ? chosen.place
      : { address, network, destination: destination as WithdrawDestination | null };
  const max = cash.data?.maxUsd[goesTo.network];
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
    setTo(null);
    setError(null);
  };
  const close = () => {
    // A proposal left on the review step is declined, so nothing lingers waiting.
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
      return setError(`You can send up to ${formatUsd(max)} to ${networkName(goesTo.network)}.`);
    if (!addressFits(goesTo.network, goesTo.address))
      return setError(
        goesTo.network === "solana"
          ? "That isn't a Solana address. Copy it again."
          : `That isn't an address on ${networkName(goesTo.network)}. It starts with 0x and has 42 characters.`,
      );
    setBusy(true);
    setError(null);
    try {
      const withdrawal = await proposeWithdrawal({
        amountUsd: dollars,
        network: goesTo.network,
        address: goesTo.address,
        destination: goesTo.destination,
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
        ? { title: "Check before it goes", lede: "Money sent to a wrong address can't come back." }
        : { title: "Withdraw", lede: "Send cash to an exchange or another wallet." };

  return (
    <MoneySheet open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogClose asChild>
        <Button
          aria-label="Close"
          className="absolute top-5 right-5 z-10"
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </DialogClose>
      {sentNow ? (
        <AuniDialogMascot state={sentNow.status === "failed" ? "sad" : "celebrating"} />
      ) : null}
      <DialogTitle className={cn("pr-10 text-title text-ink", sentNow && "mt-4 text-center")}>
        {heading.title}
      </DialogTitle>
      <DialogDescription
        className={cn("mt-1.5 text-body text-muted-foreground", sentNow && "text-center")}
      >
        {heading.lede}
      </DialogDescription>

      {step.kind === "review" ? (
        <WithdrawReview
          className="mt-6"
          withdrawal={step.withdrawal}
          onBack={() => {
            void decideAction(step.withdrawal.action.id, "decline").catch(() => {});
            setStep({ kind: "form" });
          }}
          onSent={(action) => setStep({ kind: "sent", withdrawal: { ...step.withdrawal, action } })}
        />
      ) : step.kind === "sent" ? (
        <DialogClose asChild>
          <Button className={cn(auniDialogPrimaryButtonClass, "mt-7")} type="button">
            Done
          </Button>
        </DialogClose>
      ) : (
        <form className="mt-6 flex flex-col" onSubmit={(event) => void review(event)}>
          <label className="block">
            <span className="sr-only">Amount in dollars</span>
            <span className="flex items-center gap-1 rounded-card border border-border px-4 py-3 transition-[border-color,box-shadow] focus-within:border-ink/40 focus-within:ring-[3px] focus-within:ring-ring/20">
              <span aria-hidden className="text-card-money text-faint">
                $
              </span>
              <input
                name="amount"
                autoComplete="off"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-card-money text-ink tabular-nums outline-none placeholder:text-faint"
              />
              <Button
                disabled={!max || Number(max) <= 0}
                onClick={() => max && setAmount(max)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Max
              </Button>
            </span>
          </label>
          <p className="mt-2 text-meta text-muted-foreground">
            {cash.data
              ? cashWords(cash.data)
              : cash.isError
                ? "Your cash couldn't load right now."
                : "Reading your cash"}
          </p>

          <p className="mt-6 text-meta font-semibold text-muted-foreground">To</p>
          {recent.length > 0 ? (
            <Rows role="radiogroup" aria-label="Where it goes" className="mt-1">
              {recent.map((place) => (
                <li key={`${place.network}:${place.address}`}>
                  <PlaceRow
                    on={chosen.kind === "recent" && chosen.place === place}
                    onPick={() => setTo({ kind: "recent", place })}
                    place={place}
                  />
                </li>
              ))}
              <li>
                <Pick
                  on={chosen.kind === "new"}
                  onPick={() => setTo({ kind: "new" })}
                  mark={
                    <span className="grid size-8 place-items-center rounded-full bg-foreground/[0.06] text-muted-foreground">
                      <Plus aria-hidden className="size-4" />
                    </span>
                  }
                  title="A new address"
                />
              </li>
            </Rows>
          ) : null}

          {chosen.kind === "new" ? (
            <div className={cn("flex flex-col", recent.length > 0 ? "mt-4" : "mt-2")}>
              <NetworkPicker
                label="Network to send on"
                networks={CHIPS}
                value={network}
                onChange={(key) => setNetwork(key as WithdrawNetwork)}
              />
              <label className="mt-3 block">
                <span className="sr-only">Address on {networkName(network)}</span>
                <Input
                  name="address"
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={`Paste the address on ${networkName(network)}`}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  className="h-12 px-3.5 font-mono placeholder:font-sans"
                />
              </label>
              <div
                role="radiogroup"
                aria-label="Whose address it is"
                className="mt-3 grid grid-cols-2 gap-1 rounded-control bg-foreground/[0.05] p-1"
              >
                {(
                  [
                    ["exchange", "My exchange"],
                    ["wallet", "My own wallet"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={destination === id}
                    onClick={() => setDestination(id)}
                    className={cn(
                      "h-9 rounded-control text-ui font-medium transition-colors",
                      destination === id
                        ? "bg-popover text-ink ring-1 ring-border"
                        : "text-muted-foreground hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {destination === "exchange" ? (
                <p className="mt-2 text-meta text-muted-foreground">
                  {network === "base" ? "Coinbase takes USDC on Base. " : null}Copy your
                  exchange&apos;s USDC deposit address for {networkName(network)}.
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 text-meta text-negative">
              {error}
            </p>
          ) : null}

          <Button
            className={cn(auniDialogPrimaryButtonClass, "mt-6")}
            disabled={busy}
            type="submit"
          >
            {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
            Review
          </Button>
        </form>
      )}
    </MoneySheet>
  );
}

function networkName(network: WithdrawNetwork): string {
  return NETWORKS[network].name;
}

/** One choice of where it goes, as a row: a tick ends the one picked. */
function Pick({
  on,
  onPick,
  mark,
  title,
  meta,
}: {
  readonly on: boolean;
  readonly onPick: () => void;
  readonly mark: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <Row
      role="radio"
      aria-checked={on}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onPick();
      }}
      className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
      mark={mark}
      title={title}
      meta={meta}
      end={on ? <Check aria-hidden className="size-4 text-ink" /> : null}
    />
  );
}

/** A place money went before: its network's mark, whose it is, its ends, and when. */
function PlaceRow({
  on,
  onPick,
  place,
}: {
  readonly on: boolean;
  readonly onPick: () => void;
  readonly place: RecentPlace;
}) {
  const whose =
    place.destination === "exchange"
      ? "Your exchange"
      : place.destination === "wallet"
        ? "Your wallet"
        : shortAddress(place.address);
  return (
    <Pick
      on={on}
      onPick={onPick}
      mark={
        <NetworkMark
          network={{ key: place.network, logo: NETWORKS[place.network].logo }}
          size={32}
        />
      }
      title={`${whose} on ${networkName(place.network)}`}
      meta={
        <>
          {place.destination ? (
            <span className="font-mono">{shortAddress(place.address)} </span>
          ) : null}
          Last sent {DATE.format(new Date(place.at))}
        </>
      }
    />
  );
}
