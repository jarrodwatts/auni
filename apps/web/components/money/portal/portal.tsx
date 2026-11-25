"use client";

import "./portal.css";

import "./add-money.css";

import { isCash, NETWORKS, type DepositWire, type NetworkKey } from "@auni/shared";
import { Check, Copy, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import { MascotArt } from "@/components/brand/mascot-art";
import { FullAddress } from "@/components/cards/money/full-address";
import { SpotlightShimmer } from "@/components/motion/spotlight-shimmer";
import { auniDialogPrimaryButtonClass } from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { DepositNetwork } from "@/lib/data/portfolio";
import { formatUsd, formatUsdcBalance } from "@/lib/money";
import { QR_COLORS } from "@/lib/qr";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

import { landedTotal, stillNeeded } from "../deposit-watch";
import { NetworkPicker, type PickedNetwork } from "../network-picker";
import {
  depositAddresses,
  networkNamed,
  PLACEHOLDERS,
  type DepositAddress,
} from "./deposit-addresses";
import {
  ARRIVE_MS,
  COUNT_DELAY_MS,
  COUNT_UP_MS,
  landOn,
  NOD,
  play,
  PortalHero,
} from "./portal-parts";
import { useCountUp } from "./use-count-up";

/** Where money is simplest to send: dollars, on the network Auni is built around. */
const EASIEST: NetworkKey = "monad";

/** "0.081", "250", "1,234.56": enough to recognise what was sent. */
const AMOUNT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  maximumSignificantDigits: 4,
  roundingPriority: "morePrecision",
});

interface PortalProps {
  /** Every network money can arrive on; empty until the wallets are ready. */
  readonly networks: readonly DepositNetwork[];
  /** Every deposit that landed while it was open, newest first. */
  readonly landed: readonly DepositWire[];
  /** The whole dollars a card needs, when one opened it ("50"). */
  readonly need?: string | null;
}

/**
 * Money in from an exchange or another wallet. The owner picks the network they'll send on
 * first, since that's the one choice that can lose money, and its address shows at once as a
 * code to scan, in full to check, and a button to copy, with Auni waiting in the middle of the
 * code. When money lands, the code falls away, a coin of its network flies out of that network's
 * chip into Auni, and the amount counts up. Money for a card that falls short says what's left
 * and keeps watching.
 */
export function Portal({ landed, need = null, networks }: PortalProps) {
  // Stand-in addresses hold the places until the wallets are ready.
  const ready = networks.length > 0;
  const promised = ready ? networks : PLACEHOLDERS;
  const addresses = depositAddresses(promised);
  const [picked, setPicked] = useState<NetworkKey>(EASIEST);
  const network = promised.find(({ key }) => key === picked) ?? promised[0]!;
  const entry = addresses.find((each) => each.networks.includes(network)) ?? null;
  const clipboard = useClipboardCopy();
  const copied = entry !== null && clipboard.copiedValue === entry.address;

  const total = landedTotal(landed);
  const left = stillNeeded(need, total);
  // Done once something landed and, for a card, once there's enough.
  const done = landed.length > 0 && left === 0n;
  const newest = landed[0] ?? null;
  const arriving = done && newest ? networkNamed(promised, newest.network) : null;

  const hero = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!done) return;
    // The network's coin flies into Auni, which gulps it down and hops.
    const stop = landOn(body.current, arriving !== null);
    // What was focused goes inert as Done takes its place.
    doneButton.current?.focus();
    return stop;
  }, [arriving, done]);
  // Money that isn't enough yet gets a nod; the line under the title says what's left.
  const shortLandings = done ? 0 : landed.length;
  useEffect(() => {
    if (shortLandings > 0) play(body.current, NOD, 700);
  }, [shortLandings]);

  const counted = useCountUp(
    done ? total : null,
    COUNT_UP_MS,
    arriving ? ARRIVE_MS + COUNT_DELAY_MS : COUNT_DELAY_MS,
  );
  const what = newest
    ? `${AMOUNT.format(Number(newest.amount))} ${newest.symbol} on ${newest.network}` +
      (landed.length > 1 ? `, and ${landed.length - 1} more` : "")
    : null;

  const chips = promised.map(({ key, networkName, logo }): PickedNetwork => ({
    key,
    name: networkName,
    logo,
  }));
  const { coin, usdc } = NETWORKS[network.key];

  return (
    <div
      className="auni-portal auni-add-money flex flex-col text-left"
      data-qr={done ? undefined : ""}
      data-copied={copied ? "" : undefined}
      data-arriving={arriving ? "" : undefined}
      data-counting={done && counted !== null ? "" : undefined}
      data-landed={done ? "" : undefined}
    >
      <DialogClose asChild>
        <Button
          aria-label="Close"
          className="absolute top-0 right-0 z-10"
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </DialogClose>

      <div className="auni-add-money-fold" inert={done}>
        <div className="auni-add-money-head">
          <DialogTitle className="pr-10 text-title text-ink">
            {need ? `Add ${formatUsd(need)}` : "Add money"}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-body text-muted-foreground">
            {need && landed.length > 0
              ? `${formatUsdcBalance(total)} arrived. ${formatUsdcBalance(left)} more to go.`
              : need
                ? "Send from an exchange or another wallet, then go back to your card."
                : "Send from an exchange or another wallet."}
          </DialogDescription>
          <NetworkPicker
            className="mt-5"
            label="Network to send on"
            networks={chips.filter(({ key }) => isCash(key))}
            more={chips.filter(({ key }) => !isCash(key))}
            value={network.key}
            onChange={setPicked}
          />
        </div>
      </div>

      <PortalHero
        body={body}
        className="mt-5 self-center"
        coin={newest?.symbol ?? null}
        hero={hero}
        ringed={false}
        orbit={{ networks: promised, lit: null, arriving }}
      >
        <QrCard addresses={ready ? addresses : []} shown={entry} />
      </PortalHero>

      <div className="auni-add-money-swap mt-5">
        <div className="auni-add-money-fold auni-add-money-before" inert={done}>
          <div className="flex flex-col items-center">
            <p className="min-h-12 text-center text-ui leading-6">
              {ready && entry ? (
                <FullAddress address={entry.address} />
              ) : (
                <span
                  aria-hidden
                  className="auni-loading-sheen inline-block h-4 w-56 rounded-full"
                />
              )}
            </p>
            {/* The one thing that loses money: sending on a network this address isn't for. */}
            <p className="mt-3 text-center text-ui text-ink">
              Choose <span className="font-semibold">{network.networkName}</span> as the network
              when you send.
            </p>
            <Button
              className={cn(auniDialogPrimaryButtonClass, "mt-4")}
              disabled={!ready || !entry}
              onClick={() => {
                if (!entry) return;
                clipboard.copy(entry.address);
                play(body.current, NOD, 700);
              }}
              type="button"
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? "Copied" : "Copy address"}
            </Button>
            {clipboard.blocked ? (
              <p role="alert" className="mt-2 text-center text-meta text-muted-foreground">
                Your browser blocked copying. Select the address above to copy it.
              </p>
            ) : null}
            <p className="mt-3 text-center text-meta text-muted-foreground">
              {usdc ? "Send USDC or any coin" : "Send any coin"} on {network.networkName}. A little{" "}
              {coin.asset.symbol} pays network fees.
            </p>
            <p className="mt-5 text-center text-meta text-muted-foreground">
              <SpotlightShimmer active={ready}>
                {ready
                  ? `Watching for your transfer on ${network.networkName}`
                  : "Preparing your wallet address"}
              </SpotlightShimmer>
            </p>
          </div>
        </div>

        <div
          aria-hidden={!done}
          className="auni-add-money-after flex flex-col items-center"
          inert={!done}
        >
          <p className="min-h-12 text-hero-money text-ink">
            {done && counted !== null ? formatUsdcBalance(counted) : null}
          </p>
          <p className="mt-1 min-h-6 text-center text-body text-muted-foreground">
            {done ? `${what} arrived.` : null}
          </p>
          <DialogClose asChild>
            <Button
              ref={doneButton}
              className={cn(auniDialogPrimaryButtonClass, "mt-6")}
              type="button"
            >
              Done
            </Button>
          </DialogClose>
        </div>
      </div>

      {/* Copies and landings are said apart, so neither cuts the other off. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `Copied. Choose ${network.networkName} as the network when you send.` : ""}
      </span>
      <span aria-live="polite" className="sr-only">
        {newest ? `${formatUsdcBalance(total)} arrived: ${what}.` : ""}
      </span>
    </div>
  );
}

/**
 * Every address's code, drawn once each, on a plate Auni sits in the middle of: only the one for
 * the picked network shows, so picking another EVM network keeps the same code (it is the same
 * address), and Solana swaps it for its own.
 */
function QrCard({
  addresses,
  shown,
}: {
  readonly addresses: readonly DepositAddress[];
  readonly shown: DepositAddress | null;
}) {
  return (
    <div className="auni-portal-qr">
      {addresses.map((entry) => (
        <QrCanvas key={entry.address} entry={entry} on={entry.address === shown?.address} />
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
    // that chain alone, and an EIP-681 link can put a token contract where some apps read the
    // destination. High error correction, so Auni sitting in the middle never breaks a scan.
    // Drawn at twice the size it shows, for sharp screens.
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
      aria-label="QR code for this address"
      className="auni-portal-code"
      data-on={on ? "" : undefined}
      role="img"
    />
  );
}
