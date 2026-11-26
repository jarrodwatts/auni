"use client";

import { listed } from "@auni/shared";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AssetLogo } from "@/components/brand/marks";
import { useMoney } from "@/components/money/money-provider";
import { Card } from "@/components/ui/card";
import { Row, Rows } from "@/components/ui/row";
import { Section } from "@/components/ui/section";
import type { CashPlace } from "@/lib/data/takes";
import type { Holding } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";

import { splitDust } from "./money-groups";
import { OtherTokensDialog, OtherTokensMark } from "./other-tokens";
import { otherTokensLabel } from "./other-tokens-text";

const worth = (holding: Holding) => formatUsdcBalance(BigInt(holding.value.baseUnits));

/** One holding: its logo, what it is and how much, and what it's worth, with `under` beneath. */
export function HoldingRow({
  holding,
  under,
}: {
  readonly holding: Holding;
  readonly under?: ReactNode;
}) {
  return (
    <Row
      mark={<AssetLogo holding={holding} size={32} />}
      title={holding.name}
      meta={holding.detail}
      end={
        <span className="flex flex-col items-end">
          <span className="font-medium tabular-nums">{worth(holding)}</span>
          {under}
        </span>
      }
    />
  );
}

/**
 * Cash no take holds, by where it is, as Withdraw says it: what's in the owner's wallet, ready
 * to use or send; what an app keeps, earning there or waiting to trade there; and any of it on
 * its way between networks.
 */
export function CashGroup({ places }: { readonly places: readonly CashPlace[] }) {
  const { portfolio } = useMoney();
  if (!portfolio) return null;
  const moving = portfolio.holdings.filter(({ id }) => id === "on-the-way");
  return (
    <Section heading="Cash" aria-label="Cash">
      <Card>
        <Rows className="px-4 sm:px-5">
          {places.map((place) => (
            <li key={place.venue}>
              <Row
                mark={
                  <AssetLogo
                    holding={{ logoUrl: place.venue === "wallet" ? USDC_LOGO : place.logoUrl }}
                    size={32}
                  />
                }
                title={place.venue === "wallet" ? "In your wallet" : place.name}
                meta={placeNote(place)}
                end={<span className="font-medium">{formatUsdcBalance(place.value)}</span>}
              />
            </li>
          ))}
          {moving.map((holding) => (
            <li key={holding.id}>
              <HoldingRow holding={holding} />
            </li>
          ))}
        </Rows>
      </Card>
    </Section>
  );
}

const USDC_LOGO = "/brand/tokens/usdc.svg";

function placeNote(place: CashPlace): string {
  if (place.venue !== "wallet") return place.savings ? "Earning interest" : "Ready to trade there";
  return place.value > 0n ? "Ready to use" : "None available";
}

/**
 * What no take holds: anything worth a row, then the crumbs (gas coins, dust) and the tokens
 * Auni doesn't count, folded into one quiet row that opens.
 */
export function OtherHoldings({ loose }: { readonly loose: readonly Holding[] }) {
  const { portfolio } = useMoney();
  const [open, setOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);
  const { shown, dust } = splitDust(loose, BigInt(portfolio?.totalUsd.baseUnits ?? "0"));
  const uncounted = portfolio?.otherTokens ?? 0;
  if (shown.length === 0 && dust.length === 0 && uncounted === 0) return null;
  const folded = dust.length + (uncounted > 0 ? 1 : 0);
  const dustWorth = dust.reduce((sum, holding) => sum + BigInt(holding.value.baseUnits), 0n);
  const names = [
    ...dust.map(({ name }) => name),
    ...(uncounted > 0 ? [otherTokensLabel(uncounted).toLowerCase()] : []),
  ];
  return (
    <Section heading="Other holdings" description="Not part of a take" aria-label="Other holdings">
      <Card>
        <Rows className="px-4 sm:px-5">
          {shown.map((holding) => (
            <li key={holding.id}>
              <HoldingRow holding={holding} />
            </li>
          ))}
          {folded > 0 ? (
            <li>
              <Row
                asChild
                mark={<OtherTokensMark size={32} />}
                title="Small balances"
                meta={
                  names.length > 3
                    ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
                    : listed(names)
                }
                end={
                  <>
                    {dust.length > 0 ? (
                      <span className="font-medium text-muted-foreground">
                        {formatUsdcBalance(dustWorth)}
                      </span>
                    ) : null}
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-4 text-faint transition-transform duration-200 ease-settle motion-reduce:transition-none",
                        open && "rotate-180",
                      )}
                    />
                  </>
                }
              >
                <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} />
              </Row>
            </li>
          ) : null}
          {open
            ? dust.map((holding) => (
                <li key={holding.id} className="pl-4">
                  <HoldingRow holding={holding} />
                </li>
              ))
            : null}
          {open && uncounted > 0 ? (
            <li className="pl-4">
              <Row
                asChild
                mark={<OtherTokensMark size={32} />}
                title={otherTokensLabel(uncounted)}
                meta="Not counted in your total"
              >
                <button type="button" onClick={() => setTokensOpen(true)} />
              </Row>
            </li>
          ) : null}
        </Rows>
      </Card>
      <OtherTokensDialog open={tokensOpen} onOpenChange={setTokensOpen} />
    </Section>
  );
}
