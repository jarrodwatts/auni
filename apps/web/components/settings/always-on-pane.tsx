"use client";

import type { HandedOverWire, HandoverMachine, HandoverOffer, HandoverStatus } from "@auni/shared";
import { ArrowUpRight, ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { PairAgain } from "@/components/auth/pair-again";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { CopyLine } from "@/components/ui/copy-line";
import { CoreApiError } from "@/lib/core";
import { cancelHandover, handedOverTo, offerHandover, useHandover } from "@/lib/data/handover";
import { cn } from "@/lib/utils";

import { GROUP, ROW, ROW_HINT, ROW_LABEL, ROW_TEXT } from "./rows";

/** One box of words and controls, the rows' frame without their dividers. */
const BOX = "rounded-card border border-foreground/[0.08] bg-card p-4";

/** Where to get Tailscale, for a laptop without it. */
const TAILSCALE = "https://tailscale.com/download";

const OS_NAMES: Record<string, string> = {
  linux: "Linux",
  macOS: "Mac",
  windows: "Windows (WSL)",
  iOS: "iPhone or iPad",
  android: "Android",
};

/** Why a handover ended without handing Auni over, in the owner's words. */
const ENDED: Record<
  NonNullable<NonNullable<HandoverStatus["handover"]>["ended"]>,
  string | null
> = {
  expired: "The code expired before {machine} used it. Pick a computer for a new one.",
  wrong_code: "Too many wrong codes, so that transfer closed. Pick a computer for a new one.",
  cancelled: null,
  cut_short: "The transfer to {machine} was interrupted, so Auni is still running here.",
  no_answer: "{machine} didn't respond in time, so Auni is still running here.",
  declined:
    "{machine} couldn't complete the move (check its terminal for details). Auni is still running here.",
  failed:
    "Couldn't pack up Auni here (check this terminal for details). Auni is still running here.",
};

/**
 * Moving Auni to another of the owner's computers that stays on: their machines on Tailscale,
 * one picked, and the command to run there, which installs Auni, takes everything over from this
 * one and keeps it running. The command is shown once, as it's made; the move's progress is read
 * from core as it goes.
 */
export function KeepRunning() {
  return (
    <div>
      <p className="mb-3 px-1 text-meta leading-[1.5] text-muted-foreground">
        Pick a computer on your Tailscale that stays on. Your wallet, chats, and settings move there
        once, and you can open Auni from any device.
      </p>
      <HandOver />
    </div>
  );
}

function HandOver() {
  const status = useHandover({ enabled: true });
  const [offer, setOffer] = useState<HandoverOffer | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [pairAgain, setPairAgain] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [went, setWent] = useState<HandedOverWire | null>(null);

  // Handed over, the laptop's core answers only where Auni went.
  const handedOver = status.error instanceof CoreApiError && status.error.code === "handed_over";
  useEffect(() => {
    if (handedOver) void handedOverTo().then(setWent);
  }, [handedOver]);

  const pick = async (machine: HandoverMachine) => {
    setAsking(machine.id);
    setPairAgain(false);
    setRefused(null);
    try {
      setOffer(await offerHandover(machine.id));
      await status.refetch();
    } catch (caught) {
      if (caught instanceof CoreApiError && caught.code === "pair_again") setPairAgain(true);
      else
        setRefused(
          (caught instanceof CoreApiError && caught.detail) ||
            "That didn't reach Auni, so nothing changed. Try again.",
        );
    } finally {
      setAsking(null);
    }
  };

  if (handedOver) return went ? <HandedOver went={went} /> : <Waiting />;
  if (!status.data) return <Waiting />;
  const { tailnet, handover } = status.data;

  if (handover && ["waiting", "handing", "handed"].includes(handover.stage))
    return (
      <Handing
        handover={handover}
        offer={offer?.machine === handover.machine ? offer : null}
        onCancel={async () => {
          await cancelHandover().catch(() => null);
          setOffer(null);
          await status.refetch();
        }}
      />
    );

  if (tailnet.state === "missing")
    return (
      <div className={GROUP}>
        <a
          className={cn(ROW, "hover:bg-foreground/[0.025]")}
          href={TAILSCALE}
          rel="noreferrer"
          target="_blank"
        >
          <span className={ROW_TEXT}>
            <span className={ROW_LABEL}>Get Tailscale (free)</span>
            <span className={cn(ROW_HINT, "whitespace-normal")}>
              Install it on this computer and the one Auni will run on, using the same account.
              That&apos;s how your devices reach Auni privately.
            </span>
          </span>
          <ArrowUpRight aria-hidden className="size-4 flex-none text-faint" />
        </a>
      </div>
    );

  if (tailnet.state === "off")
    return (
      <div className={GROUP}>
        <button
          type="button"
          className={cn(ROW, "w-full text-left hover:bg-foreground/[0.025]")}
          onClick={() => void status.refetch()}
        >
          <span className={ROW_TEXT}>
            <span className={ROW_LABEL}>Tailscale isn&apos;t connected</span>
            <span className={ROW_HINT}>Open Tailscale and sign in, then check again</span>
          </span>
          {status.isFetching ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin text-faint" />
          ) : null}
        </button>
      </div>
    );

  const said = handover?.ended ? ENDED[handover.ended] : null;
  const others = tailnet.machines.filter((machine) => !machine.here);
  return (
    <>
      {said ? (
        <p role="status" className="mb-3 px-1 text-meta leading-[1.5] text-muted-foreground">
          {said.replace("{machine}", handover!.machine)}
        </p>
      ) : null}
      <div className={GROUP}>
        {others.map((machine) => (
          <MachineRow
            key={machine.id}
            machine={machine}
            asking={asking === machine.id}
            onPick={() => void pick(machine)}
          />
        ))}
        {others.length === 0 ? (
          <p className={cn(ROW, ROW_HINT, "whitespace-normal")}>
            No other computers on your Tailscale yet. Install Tailscale on the computer you want
            Auni to run on.
          </p>
        ) : null}
      </div>
      {pairAgain ? <PairAgain className="mt-3" then="Then pick the computer again." /> : null}
      {refused ? (
        <p role="alert" className="mt-3 px-1 text-meta leading-[1.5] text-destructive">
          {refused}
        </p>
      ) : null}
    </>
  );
}

/** One of the owner's machines, which a tap picks when Auni can run there now. */
function MachineRow({
  machine,
  asking,
  onPick,
}: {
  readonly machine: HandoverMachine;
  readonly asking: boolean;
  readonly onPick: () => void;
}) {
  const os = OS_NAMES[machine.os] ?? machine.os;
  const hint = !machine.runsAuni
    ? `${os} (can't run Auni)`
    : machine.online
      ? `${os}, online`
      : `${os}, offline`;
  const can = machine.runsAuni && machine.online;
  return (
    <button
      type="button"
      disabled={!can || asking}
      onClick={onPick}
      className={cn(
        ROW,
        "w-full text-left transition-colors hover:bg-foreground/[0.025] disabled:cursor-not-allowed",
        !can && "opacity-55",
      )}
    >
      <span className={ROW_TEXT}>
        <span className={ROW_LABEL}>{machine.name}</span>
        <span className={ROW_HINT}>{hint}</span>
      </span>
      {asking ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin text-faint" />
      ) : can ? (
        <ChevronRight aria-hidden className="-mr-1 size-4 text-faint" />
      ) : null}
    </button>
  );
}

/** A handover under way: the command while it waits for the machine, then its progress. */
function Handing({
  handover,
  offer,
  onCancel,
}: {
  readonly handover: NonNullable<HandoverStatus["handover"]>;
  readonly offer: HandoverOffer | null;
  readonly onCancel: () => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false);
  const until = new Date(handover.expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (handover.stage !== "waiting")
    return (
      <div className={BOX}>
        <p className="flex items-center gap-2 text-ui text-ink">
          <LoaderCircle aria-hidden className="size-4 animate-spin text-muted-foreground" />
          Moving Auni to {handover.machine}
        </p>
        <p className="mt-1.5 text-meta leading-[1.5] text-muted-foreground">
          Auni is paused here. Once {handover.machine} has everything, Auni will run there and stop
          here.
        </p>
      </div>
    );
  return (
    <div className={BOX}>
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-ui font-medium text-ink">
          Run this on {handover.machine}
        </p>
        <MoneyButton
          tone="outline"
          busy={cancelling}
          onClick={() => {
            setCancelling(true);
            void onCancel().finally(() => setCancelling(false));
          }}
        >
          Cancel
        </MoneyButton>
      </div>
      <p className="mt-1 text-meta leading-[1.5] text-muted-foreground">
        {offer
          ? `Run this in ${handover.machine}'s terminal (or hand it to your coding agent there). It installs Auni and moves everything over. This one-time code expires at ${until}.`
          : "The command was shown once when you started. Cancel and pick the computer again for a new one."}
      </p>
      {offer ? <CopyLine value={offer.command} command className="mt-3" /> : null}
    </div>
  );
}

/** Handed over: Auni runs on the other machine now. */
function HandedOver({ went }: { readonly went: HandedOverWire }) {
  return (
    <div className={BOX}>
      <p className="text-ui font-medium text-ink">Auni is now running on {went.machine}</p>
      <p className="mt-1 text-meta leading-[1.5] text-muted-foreground">
        It may take a minute to start. Your local files weren&apos;t deleted, and Auni is stopped on
        this computer.
      </p>
      <MoneyButton
        tone="primary"
        className="mt-3 w-full"
        onClick={() => window.location.assign(went.to)}
      >
        Open Auni on {went.machine}
      </MoneyButton>
    </div>
  );
}

function Waiting() {
  return (
    <div role="status" className="flex justify-center py-6">
      <LoaderCircle aria-hidden className="size-5 animate-spin text-faint" />
      <span className="sr-only">Looking for your computers</span>
    </div>
  );
}
