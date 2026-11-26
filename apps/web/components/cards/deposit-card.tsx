"use client";

import { DEPOSIT_WAIT_MS, type DepositCardWire, type NetworkKey } from "@auni/shared";
import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";

import { useMoney } from "@/components/money/money-provider";
import {
  depositAddresses,
  networkNames,
  PLACEHOLDERS,
  watchedTokens,
} from "@/components/money/portal/deposit-addresses";
import { NetworkChip } from "@/components/money/portal/network-chip";
import {
  addressRowsClass,
  AddressRow,
  COUNT_UP_MS,
  RowSkeleton,
} from "@/components/money/portal/portal-parts";
import { useCountUp } from "@/components/money/portal/use-count-up";
import { buttonVariants } from "@/components/ui/button";
import { QrCodeCanvas } from "@/components/ui/qr-code";
import type { DepositNetwork } from "@/lib/data/portfolio";
import { dollarsToBaseUnits } from "@/lib/data/usdc";
import { formatUsdcBalance } from "@/lib/money";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

import { movedLine } from "./arrival-card";
import { CardFrame, CardHead } from "./card-parts";
import { FullAddress } from "./money/full-address";

/**
 * Where to send money in, as wait_for_deposit shows it: a card like every other, led by what the
 * owner needs to send it. On one network that is its code and its whole address, side by side;
 * on several, a row for each address, each with its code a tap away. Auni peeks over its edge
 * while it waits on their transfer. Once core lands it, the same card says what came in, and
 * Auni's reply under it says what's next. A day on, its wait is over (core tells later money in
 * their main chat), so it still shows their addresses but watches for nothing.
 */
export function DepositCard({ card }: { readonly card: DepositCardWire }) {
  const { depositNetworks, watchDeposits } = useMoney();
  const { landed, network } = card;
  // Stand-in addresses hold the rows' places until the account's wallets are ready.
  const ready = depositNetworks.length > 0;
  const promised = offeredOn(ready ? depositNetworks : PLACEHOLDERS, network);
  const addresses = depositAddresses(promised);
  const clipboard = useClipboardCopy();
  const find = (address: string | null) =>
    addresses.find((entry) => entry.address === address) ?? null;
  const copied = find(clipboard.copiedValue);
  // Several addresses: the one whose code is open, as Add money draws it.
  const [opened, setOpened] = useState<string | null>(null);
  const qr = find(opened);
  // One network is named once, in the head, and its one address leads with its code.
  const one = network !== null && promised.length === 1 ? (addresses[0] ?? null) : null;

  const isLanded = landed !== null;
  const [shownAt] = useState(Date.now);
  const watching = !isLanded && shownAt - Date.parse(card.updatedAt) < DEPOSIT_WAIT_MS;
  // A card drawn from history already landed is simply there; one landing on screen counts up.
  const [drawnLanded] = useState(isLanded);
  // Read the money more often while it waits on screen, so what lands shows sooner.
  useEffect(() => (watching ? watchDeposits() : undefined), [watching, watchDeposits]);

  const total = landed ? dollarsToBaseUnits(landed.usdValue) : null;
  const counted = useCountUp(drawnLanded ? null : total, COUNT_UP_MS, 0);
  const them = card.tokens.length > 1 ? "them" : "it";

  return (
    <CardFrame
      // Auni keeps them company while it waits on their transfer, and cheers when it lands.
      auni={watching ? { kind: "funding" } : isLanded && !drawnLanded ? { kind: "landed" } : null}
      label={total !== null ? `${formatUsdcBalance(total)} arrived` : card.title}
      phase="open"
      // Amber while it waits on the owner's transfer; once it lands, a plain edge.
      tone={watching ? "waiting" : null}
    >
      <CardHead
        // Where the money goes: Auni itself is already here, peeking over the card's edge.
        mark={
          <span className="flex size-11 flex-none items-center justify-center rounded-full bg-glyph-plate text-glyph-ink">
            <Wallet aria-hidden className="size-5" strokeWidth={2} />
          </span>
        }
        title={card.title}
        line={
          landed ? (
            movedLine(landed)
          ) : network && promised[0] ? (
            <span className="text-body">
              {watching ? "Send it on" : "Your address on"}
              <NetworkChip network={promised[0]} />
            </span>
          ) : watching ? (
            `Watching your addresses for ${them}`
          ) : (
            "Your addresses"
          )
        }
        figure={
          total !== null
            ? {
                value: formatUsdcBalance(drawnLanded ? total : (counted ?? total)),
                note: "arrived",
              }
            : null
        }
      />

      {isLanded ? null : (
        <div className="mt-5 border-t border-border pt-5">
          {one && ready ? (
            <OneAddress
              address={one.address}
              copied={copied === one}
              names={networkNames(one.networks)}
              onCopy={() => clipboard.copy(one.address)}
            />
          ) : (
            <>
              <div className={addressRowsClass}>
                {ready
                  ? addresses.map((entry) => (
                      <AddressRow
                        key={entry.address}
                        blocked={clipboard.blocked}
                        copied={copied === entry}
                        entry={entry}
                        on={qr === entry}
                        onToggleQr={() =>
                          setOpened(opened === entry.address ? null : entry.address)
                        }
                        onCopy={() => clipboard.copy(entry.address)}
                      />
                    ))
                  : addresses.map((entry) => <RowSkeleton key={entry.address} />)}
              </div>
              {qr ? (
                <div className="mt-4 flex flex-col items-center gap-3">
                  <p className="text-meta leading-[18px] text-muted-foreground">
                    Send on {networkNames(qr.networks)}
                  </p>
                  <QrCodeCanvas
                    label={`QR code for your ${networkNames(qr.networks)} address`}
                    size={168}
                    value={qr.address}
                  />
                  <p className="max-w-[320px] text-center font-mono text-meta leading-[18px] break-all text-ink select-all">
                    {qr.address}
                  </p>
                </div>
              ) : null}
            </>
          )}
          {watchedTokens(card.tokens).map((token) => (
            <p key={token} className="mt-3 text-meta leading-[18px] text-muted-foreground">
              {token}
            </p>
          ))}
          <p className="mt-3 text-meta leading-[18px] text-pretty text-muted-foreground">
            {promised.length > 1 ? "Only send on the networks above. " : null}
            {watching ? "Watching for your transfer. This card updates when it lands." : null}
          </p>
          {clipboard.blocked ? (
            <p role="alert" className="mt-2 text-meta text-muted-foreground">
              Copying was blocked. Select the address to copy it.
            </p>
          ) : null}
        </div>
      )}

      {/* Copies and landings are said apart, so neither cuts the other off. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `Copied your ${networkNames(copied.networks)} address.` : ""}
      </span>
      <span aria-live="polite" className="sr-only">
        {total !== null && landed
          ? `${formatUsdcBalance(total)} arrived: ${movedLine(landed)}.`
          : ""}
      </span>
    </CardFrame>
  );
}

/** One network's address, as it is sent to: its code beside it in full, and one tap to copy it. */
function OneAddress({
  address,
  copied,
  names,
  onCopy,
}: {
  readonly address: string;
  readonly copied: boolean;
  readonly names: string;
  readonly onCopy: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
      <QrCodeCanvas
        className="flex-none"
        label={`QR code for your ${names} address`}
        size={128}
        value={address}
      />
      <div className="flex min-w-0 flex-1 basis-56 flex-col items-start gap-3">
        <div className="min-w-0">
          <p className="text-caption text-muted-foreground">Your {names} address</p>
          <FullAddress address={address} className="mt-1 block text-ui leading-6 select-all" />
        </div>
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy your ${names} address`}
          className={cn(buttonVariants({ size: "sm", variant: "secondary" }), "grid")}
        >
          {/* Both words share one cell, so the button never changes width. */}
          <span className={cn("[grid-area:1/1]", copied && "invisible")}>Copy address</span>
          <span className={cn("[grid-area:1/1]", !copied && "invisible")}>Copied</span>
        </button>
      </div>
    </div>
  );
}

/** The networks a card offers: the one they'll send on, or every one. */
function offeredOn(
  networks: readonly DepositNetwork[],
  key: NetworkKey | null,
): readonly DepositNetwork[] {
  return key ? networks.filter((entry) => entry.key === key) : networks;
}
