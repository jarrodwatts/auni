"use client";

import { DEPOSIT_WAIT_MS, type DepositCardWire, type NetworkKey } from "@auni/shared";
import { useEffect, useRef, useState } from "react";

import { useMoney } from "@/components/money/money-provider";
import {
  depositAddresses,
  networkNamed,
  networkNames,
  PLACEHOLDERS,
  watchedTokens,
} from "@/components/money/portal/deposit-addresses";
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
} from "@/components/money/portal/portal-parts";
import { NetworkChip } from "@/components/money/portal/network-chip";
import { useCountUp } from "@/components/money/portal/use-count-up";
import { useGaze } from "@/components/money/portal/use-gaze";
import type { DepositNetwork } from "@/lib/data/portfolio";
import { dollarsToBaseUnits } from "@/lib/data/usdc";
import { formatUsdcBalance } from "@/lib/money";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";

import { movedLine } from "./arrival-card";
import { MoneyCardFrame } from "./money/money-card-parts";

/**
 * Where to send money in, as wait_for_deposit shows it: the Portal in the chat. Auni waits in the
 * orbit of the network they'll send on, above their own address there, or of all of them over
 * all of theirs; a coin of the landed network flies into Auni. Once core lands it, the same card says what came in, as Auni hops; Auni's reply under
 * it says what's next, so the card asks nothing more of them. A day on, its wait is over (core
 * tells later money in their main chat), so it still shows their addresses but watches for nothing.
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
  // The row in hand (pointed at, focused or copied) lights its networks on the orbit.
  const [pointed, setPointed] = useState<string | null>(null);
  const inHand = find(pointed) ?? copied;

  const isLanded = landed !== null;
  const [shownAt] = useState(Date.now);
  const watching = !isLanded && shownAt - Date.parse(card.updatedAt) < DEPOSIT_WAIT_MS;
  // A card drawn from history already landed is simply there; one landing on screen celebrates.
  const [drawnLanded] = useState(isLanded);
  // Its network's coin flies into Auni first, then Auni hops.
  const arriving = landed && !drawnLanded ? networkNamed(promised, landed.network) : null;
  const hero = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  useGaze(hero, watching);
  useEffect(() => {
    if (!isLanded || drawnLanded) return;
    return landOn(body.current, arriving !== null);
  }, [arriving, drawnLanded, isLanded]);
  // Read the money more often while it waits on screen, so what lands shows sooner.
  useEffect(() => (watching ? watchDeposits() : undefined), [watching, watchDeposits]);

  const total = landed ? dollarsToBaseUnits(landed.usdValue) : null;
  const counted = useCountUp(
    drawnLanded ? null : total,
    COUNT_UP_MS,
    arriving ? ARRIVE_MS + COUNT_DELAY_MS : COUNT_DELAY_MS,
  );
  const what = landed ? movedLine(landed) : null;
  const them = card.tokens.length > 1 ? "them" : "it";

  return (
    <MoneyCardFrame
      label={total !== null ? `${formatUsdcBalance(total)} arrived` : card.title}
      phase="open"
    >
      <div
        className="auni-portal auni-deposit-card isolate flex flex-col items-center text-center"
        data-arriving={arriving ? "" : undefined}
        data-copied={copied ? "" : undefined}
        data-counting={drawnLanded || counted !== null ? "" : undefined}
        data-landed={isLanded ? "" : undefined}
      >
        <PortalHero
          body={body}
          coin={landed?.moved[0]?.symbol ?? null}
          hero={hero}
          orbit={{
            networks: promised,
            lit: isLanded ? null : (inHand?.networks ?? null),
            arriving,
          }}
        />

        <div className="auni-portal-texts mt-3 w-full">
          <div aria-hidden={isLanded} className="auni-portal-waiting">
            <p className="text-[21px] leading-[27px] font-bold tracking-[-0.03em] text-ink">
              {card.title}
            </p>
            <p className="mt-1.5 text-[14.5px] leading-[28px] text-muted-foreground">
              {network && promised[0] ? (
                <>
                  {watching ? "Send it on" : "Your address on"}
                  <NetworkChip network={promised[0]} />
                </>
              ) : watching ? (
                `Watching your addresses for ${them}`
              ) : (
                "Your addresses"
              )}
            </p>
            {watchedTokens(card.tokens).map((token) => (
              <p key={token} className="mt-1 text-[12.5px] leading-[18px] text-muted-foreground">
                {token}
              </p>
            ))}
          </div>
          <div aria-hidden={!isLanded} className="auni-portal-landing">
            <p className="text-[44px] leading-[48px] font-bold tracking-[-0.035em] text-ink tabular-nums">
              {total !== null && (drawnLanded || counted !== null)
                ? formatUsdcBalance(drawnLanded ? total : (counted ?? total))
                : null}
            </p>
            <p className="mt-1 text-[15px] leading-[22px] text-balance text-muted-foreground">
              {what}
            </p>
          </div>
        </div>

        <div className="auni-portal-addresses w-full" inert={isLanded}>
          <div className="pt-[18px]">
            <div className={addressRowsClass}>
              {ready
                ? addresses.map((entry) => (
                    <AddressRow
                      key={entry.address}
                      blocked={clipboard.blocked}
                      copied={copied === entry}
                      entry={entry}
                      onCopy={() => {
                        clipboard.copy(entry.address);
                        play(body.current, NOD, 700);
                      }}
                      onPoint={(on) =>
                        setPointed((current) =>
                          on ? entry.address : current === entry.address ? null : current,
                        )
                      }
                    />
                  ))
                : addresses.map((entry) => <RowSkeleton key={entry.address} />)}
            </div>
            <p className="mt-3 text-[12.5px] leading-[18px] text-muted-foreground">
              {/* The orbit above shows every network; a few are named too. */}
              {/* One network is named above, where a tap says what it means; more show on the orbit. */}
              {promised.length > 1 ? "Only send on the networks above. " : null}
              {watching ? "I'll reply here when it lands." : null}
            </p>
            {clipboard.blocked ? (
              <p role="alert" className="mt-2 text-[12.5px] text-muted-foreground">
                Copying was blocked. Select the address to copy it.
              </p>
            ) : null}
          </div>
        </div>

        {/* Copies and landings are said apart, so neither cuts the other off. */}
        <span aria-live="polite" className="sr-only">
          {copied ? `Copied your ${networkNames(copied.networks)} address.` : ""}
        </span>
        <span aria-live="polite" className="sr-only">
          {total !== null ? `${formatUsdcBalance(total)} arrived: ${what}.` : ""}
        </span>
      </div>
    </MoneyCardFrame>
  );
}

/** The networks a card offers: the one they'll send on, or every one. */
function offeredOn(
  networks: readonly DepositNetwork[],
  key: NetworkKey | null,
): readonly DepositNetwork[] {
  return key ? networks.filter((entry) => entry.key === key) : networks;
}
