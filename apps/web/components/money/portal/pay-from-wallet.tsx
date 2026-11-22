"use client";

import { FUNDING_FROM, NETWORKS, type FundingQuoteWire } from "@auni/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BaseError, UserRejectedRequestError, type Address, type EIP1193Provider } from "viem";

import { Button } from "@/components/ui/button";
import { browserWallet, connect, runSteps, switchTo, walletSender } from "@/lib/browser-wallet";
import { CoreApiError } from "@/lib/core";
import { fundingStatus, quoteFunding } from "@/lib/data/funding";

/** How often a payment on its way is asked after, and for how long. */
const POLL_MS = 3_000;
const POLL_FOR_MS = 5 * 60_000;

type Stage =
  | { readonly kind: "closed" }
  | { readonly kind: "form"; readonly error?: string }
  | { readonly kind: "working"; readonly say: string }
  | {
      readonly kind: "quoted";
      readonly quote: FundingQuoteWire;
      readonly account: Address;
      readonly from: (typeof FUNDING_FROM)[number];
    }
  | { readonly kind: "sent"; readonly say: string };

// A browser wallet is installed or not for the page's life; the server renders none.
const noChange = () => () => {};

/**
 * Add money's other way in: USDC from a browser wallet on another chain, carried to Auni's Monad
 * address by core's pay-in app, with a dollar of it as MON for fees while the wallet holds little. The
 * browser wallet asks before each send; the Portal celebrates once the money lands. `opened`
 * shows the form at once rather than behind a link, as first run's Add money does.
 */
export function PayFromWallet({ opened = false }: { readonly opened?: boolean }) {
  const provider = useSyncExternalStore(noChange, browserWallet, () => null);
  const [stage, setStage] = useState<Stage>({ kind: opened ? "form" : "closed" });
  const [from, setFrom] = useState<(typeof FUNDING_FROM)[number]>(FUNDING_FROM[0]!);
  const [amount, setAmount] = useState("");
  // Stops a payment's status checks once the Portal closes.
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );

  if (!provider) return null;
  if (stage.kind === "closed")
    return (
      <button
        type="button"
        className="mt-2 text-[12.5px] leading-[18px] font-semibold text-primary hover:underline"
        onClick={() => setStage({ kind: "form" })}
      >
        Or pay from a browser wallet
      </button>
    );

  const failed = (error: unknown) => setStage({ kind: "form", error: plainly(error) });

  async function quote(wallet: EIP1193Provider) {
    try {
      setStage({ kind: "working", say: "Connecting your wallet" });
      const account = await connect(wallet);
      setStage({ kind: "working", say: "Getting a quote" });
      const quoted = await quoteFunding({
        chainId: NETWORKS[from].viem.id,
        amountUsdc: amount.trim(),
        user: account,
      });
      setStage({ kind: "quoted", quote: quoted, account, from });
    } catch (error) {
      failed(error);
    }
  }

  async function pay(wallet: EIP1193Provider, quoted: Extract<Stage, { kind: "quoted" }>) {
    const { quote: q, account } = quoted;
    try {
      await switchTo(wallet, NETWORKS[quoted.from].viem);
      await runSteps(q.steps, walletSender(wallet, account), (index) =>
        setStage({
          kind: "working",
          say: `Confirm in your wallet: ${q.steps[index]!.description || q.steps[index]!.id} (${index + 1} of ${q.steps.length})`,
        }),
      );
    } catch (error) {
      return failed(error);
    }
    setStage({ kind: "sent", say: "On its way to Auni on Monad." });
    const until = Date.now() + POLL_FOR_MS;
    while (open.current && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const status = await fundingStatus(q.requestId).catch(() => "pending" as const);
      if (status === "pending") continue;
      if (!open.current) return;
      return setStage({
        kind: "sent",
        say:
          status === "success"
            ? "Delivered: Auni shows it as soon as it reads the chain."
            : status === "refunded"
              ? `${q.by} couldn't deliver it, and sent it back to your wallet.`
              : `${q.by} couldn't deliver it. Its status page for this payment says what happens next.`,
      });
    }
  }

  return (
    <div className="mt-3 rounded-[14px] bg-primary/[0.04] p-3 text-left text-[13px] leading-[18px] text-muted-foreground">
      {stage.kind === "form" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void quote(provider);
          }}
        >
          <span className="font-semibold text-ink">Pay USDC from a browser wallet</span>
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="pay-from-chain">
              From
            </label>
            <select
              id="pay-from-chain"
              className="h-9 rounded-md border bg-background px-2 text-ink"
              value={from}
              onChange={(event) => setFrom(event.target.value as typeof from)}
            >
              {FUNDING_FROM.map((key) => (
                <option key={key} value={key}>
                  {NETWORKS[key].name}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="pay-from-amount">
              USDC
            </label>
            <input
              id="pay-from-amount"
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-ink tabular-nums"
              inputMode="decimal"
              placeholder="USDC"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={!/^\d+(\.\d{1,6})?$/u.test(amount.trim())}>
              Quote
            </Button>
          </div>
          {stage.error ? <p role="alert">{stage.error}</p> : null}
        </form>
      ) : stage.kind === "quoted" ? (
        <div className="flex items-center gap-3">
          <p className="flex-1">
            Auni gets about {dollars(stage.quote.receiveUsdc)} USDC on Monad
            {stage.quote.receiveMon
              ? `, plus ${dollars(stage.quote.receiveMon)} MON for its network fees`
              : ""}
            .
          </p>
          <Button size="sm" type="button" onClick={() => void pay(provider, stage)}>
            Pay
          </Button>
        </div>
      ) : (
        <p aria-live="polite">{stage.say}</p>
      )}
    </div>
  );
}

const AMOUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dollars = (value: string) => AMOUNT.format(Number(value));

/** What went wrong, for the person: core's sentence, the wallet's no, or a plain fallback. */
function plainly(error: unknown): string {
  if (error instanceof CoreApiError)
    return error.detail ?? "Auni couldn't get a quote for that. Try another amount or chain.";
  if (error instanceof BaseError)
    return error.walk((cause) => cause instanceof UserRejectedRequestError)
      ? "You turned it down in your wallet, so nothing more was sent."
      : error.shortMessage;
  return error instanceof Error ? error.message : "Something went wrong, so nothing more was sent.";
}
