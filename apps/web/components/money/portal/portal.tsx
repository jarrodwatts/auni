"use client";

import type { DepositWire } from "@auni/shared";
import { X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import { MascotArt } from "@/components/brand/mascot-art";
import { auniDialogPrimaryButtonClass } from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { DepositNetwork } from "@/lib/data/portfolio";
import { dollarsToBaseUnits } from "@/lib/data/usdc";
import { formatUsd, formatUsdcBalance } from "@/lib/money";
import { QR_COLORS } from "@/lib/qr";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

import {
  depositAddresses,
  networkNamed,
  networkNames,
  PLACEHOLDERS,
  type DepositAddress,
} from "./deposit-addresses";
import {
  addressRowsClass,
  AddressRow,
  ARRIVE_MS,
  COUNT_DELAY_MS,
  COUNT_UP_MS,
  landOn,
  NOD,
  play,
  PortalHero,
  RowSkeleton,
} from "./portal-parts";
import { PayFromWallet } from "./pay-from-wallet";
import { useCountUp } from "./use-count-up";
import { useGaze } from "./use-gaze";

/** Where money for a card is simplest to send: dollars, on the network Auni is built around. */
const EASIEST = "Monad";

/** "0.081", "250", "1,234.56": enough to recognise what was sent. */
const AMOUNT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  maximumSignificantDigits: 4,
  roundingPriority: "morePrecision",
});

interface PortalProps {
  /** Every network money can arrive on; empty until the account's wallets are ready. */
  readonly networks: readonly DepositNetwork[];
  /** The deposit that landed while it was open, once one has. */
  readonly landed: DepositWire | null;
  /** The whole dollars a card needs, when one opened it ("50"). */
  readonly need?: string | null;
}

/**
 * Money in from any other wallet or exchange, with no network to pick: one address takes it on
 * every EVM network, and Solana has its own. Auni waits front and centre in the orbit of every
 * network it takes, and watches what you do; an address in hand lights its networks, its code
 * grows out around Auni, and when the money lands a coin of its network flies into Auni, which
 * celebrates.
 */
export function Portal({ landed, need = null, networks }: PortalProps) {
  // Stand-in addresses hold the rows' places until the account's wallets are ready.
  const ready = networks.length > 0;
  const promised = ready ? networks : PLACEHOLDERS;
  const addresses = depositAddresses(promised);
  const clipboard = useClipboardCopy();
  // The row in hand (pointed at or focused) lights its networks on the orbit; a code shows only
  // once its button opens it.
  const [pointed, setPointed] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const find = (address: string | null) =>
    addresses.find((entry) => entry.address === address) ?? null;
  const qr = landed ? null : find(opened);
  const copied = find(clipboard.copiedValue);
  const inHand = find(pointed) ?? copied;

  const hero = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  useGaze(hero, qr === null && landed === null);
  const arriving = landed ? networkNamed(promised, landed.network) : null;
  useEffect(() => {
    if (!landed) return;
    // The network's coin flies into Auni, which gulps it down and hops.
    const stop = landOn(body.current, arriving !== null);
    // The addresses go inert as Done takes their place, which would leave a keyboard's focus
    // on nothing, outside the dialog.
    done.current?.focus();
    return stop;
  }, [arriving, landed]);

  // Escape folds an open code away rather than closing everything. Heard on the window as the key
  // comes down, it's handled before the dialog's own listener on the document sees it.
  const qrOpen = qr !== null;
  useEffect(() => {
    if (!qrOpen) return;
    const fold = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpened(null);
    };
    window.addEventListener("keydown", fold, { capture: true });
    return () => window.removeEventListener("keydown", fold, { capture: true });
  }, [qrOpen]);

  const arrived = landed ? dollarsToBaseUnits(landed.usdValue) : null;
  const counted = useCountUp(
    arrived,
    COUNT_UP_MS,
    arriving ? ARRIVE_MS + COUNT_DELAY_MS : COUNT_DELAY_MS,
  );
  const what = landed
    ? `${AMOUNT.format(Number(landed.amount))} ${landed.symbol} on ${landed.network}`
    : null;

  return (
    <div
      className="auni-portal flex flex-col items-center text-center"
      data-copied={copied ? "" : undefined}
      data-arriving={arriving ? "" : undefined}
      data-counting={landed && counted !== null ? "" : undefined}
      data-landed={landed ? "" : undefined}
      data-qr={qr ? "" : undefined}
    >
      <PortalHero
        body={body}
        className="mt-1"
        coin={landed?.symbol ?? null}
        hero={hero}
        orbit={{
          networks: promised,
          // While a code shows, the orbit holds still behind it; once money lands, only the mark
          // it came on moves, into Auni.
          lit: qr || landed ? null : (inHand?.networks ?? null),
          arriving,
          still: qr !== null,
        }}
      >
        <QrCard addresses={ready ? addresses : []} onFold={() => setOpened(null)} shown={qr} />
      </PortalHero>

      <div className="auni-portal-texts mt-[18px] w-full">
        <div className="auni-portal-waiting">
          <DialogTitle className="text-[26px] leading-8 font-bold tracking-[-0.03em] text-ink">
            {need ? `Send me ${formatUsd(need)}` : "Send me anything"}
          </DialogTitle>
          {/* For a card, the simplest way to the amount; else, everything it takes. */}
          <DialogDescription className="mt-1.5 text-[15px] leading-[22px] text-muted-foreground">
            {need ? (
              `USDC on ${EASIEST} is easiest`
            ) : (
              <>
                <span aria-hidden>Any coin, on any of these networks</span>
                <span className="sr-only">Any coin, on {networkNames(promised)}.</span>
              </>
            )}
          </DialogDescription>
        </div>
        {/* Its lines hold their height while empty, so the dialog is as tall before as after. */}
        <div aria-hidden className="auni-portal-landing">
          <p className="min-h-12 text-[44px] leading-[48px] font-bold tracking-[-0.035em] text-ink tabular-nums">
            {landed && counted !== null ? formatUsdcBalance(counted) : null}
          </p>
          {/* What came, once the amount has counted all the way to it. */}
          <p
            className={cn(
              "mt-1 min-h-[22px] text-[15px] leading-[22px] text-muted-foreground transition-opacity duration-300 motion-reduce:transition-none",
              counted === arrived ? "opacity-100" : "opacity-0",
            )}
          >
            {what}
          </p>
        </div>
      </div>

      {/* In the corner, but next after the title the dialog opens on, so Tab reaches it first. */}
      <DialogClose aria-label="Close" className={cn(cornerButtonClass, "right-4")}>
        <X aria-hidden className="size-4" />
      </DialogClose>

      <div className="auni-portal-acts mt-6 w-full">
        <div className="auni-portal-addresses" inert={landed !== null}>
          <div className={addressRowsClass}>
            {ready
              ? addresses.map((entry) => (
                  <AddressRow
                    key={entry.address}
                    blocked={clipboard.blocked}
                    copied={copied === entry}
                    entry={entry}
                    on={qr === entry}
                    onCopy={() => {
                      clipboard.copy(entry.address);
                      play(body.current, NOD, 700);
                    }}
                    onPoint={(on) =>
                      setPointed((current) =>
                        on ? entry.address : current === entry.address ? null : current,
                      )
                    }
                    onToggleQr={() => setOpened(opened === entry.address ? null : entry.address)}
                  />
                ))
              : addresses.map((entry) => <RowSkeleton key={entry.address} />)}
          </div>
          {ready ? <PayFromWallet /> : null}
        </div>
        <DialogClose asChild>
          <Button
            ref={done}
            className={cn(auniDialogPrimaryButtonClass, "auni-portal-done h-12")}
            inert={landed === null}
            type="button"
          >
            Done
          </Button>
        </DialogClose>
      </div>
      {clipboard.blocked ? (
        <p role="alert" className="mt-3 text-[12.5px] text-muted-foreground">
          Copying was blocked. Select the address to copy it.
        </p>
      ) : null}

      {/* Copies and landings are said apart, so neither cuts the other off. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `Copied your ${networkNames(copied.networks)} address.` : ""}
      </span>
      <span aria-live="polite" className="sr-only">
        {landed
          ? `${formatUsdcBalance(dollarsToBaseUnits(landed.usdValue))} arrived: ${what}.`
          : ""}
      </span>
    </div>
  );
}

const cornerButtonClass =
  "absolute top-4 z-10 grid size-[30px] place-items-center rounded-full bg-foreground/[0.05] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.09] hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35";

/**
 * Every address's code, drawn once each, in a card that grows out around Auni; only the one
 * shown is unveiled, so moving between rows swaps one code for the other. A tap folds it away.
 */
function QrCard({
  addresses,
  onFold,
  shown,
}: {
  readonly addresses: readonly DepositAddress[];
  readonly onFold: () => void;
  readonly shown: DepositAddress | null;
}) {
  return (
    // The code button on the row is the way to it by keyboard; this is a shortcut for a tap.
    <div aria-hidden={shown ? undefined : true} className="auni-portal-qr" onClick={onFold}>
      {addresses.map((entry) => (
        <QrCanvas key={entry.address} entry={entry} on={entry === shown} />
      ))}
      <span className="auni-portal-qr-hole">
        <span className="auni-portal-qr-mascot">
          <MascotArt />
        </span>
      </span>
    </div>
  );
}

function QrCanvas({ entry, on }: { readonly entry: DepositAddress; readonly on: boolean }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!canvas) return;
    // The bare address, nothing else. A link naming one chain would steer the scanning wallet to
    // that chain alone, though the address takes money on every network listed with it, and an
    // EIP-681 link can put a token contract where some apps read the destination. High error
    // correction, so Auni sitting on the middle never breaks a scan. Drawn at twice the size it
    // shows, for sharp screens.
    void QRCode.toCanvas(canvas, entry.address, {
      width: 384,
      margin: 0,
      errorCorrectionLevel: "H",
      color: QR_COLORS,
    });
  }, [canvas, entry.address]);
  return (
    <canvas
      ref={setCanvas}
      aria-hidden={on ? undefined : true}
      aria-label={`QR code for your ${networkNames(entry.networks)} address`}
      className="auni-portal-code"
      data-on={on ? "" : undefined}
      role="img"
    />
  );
}
