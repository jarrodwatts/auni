"use client";

import { listed } from "@auni/shared";
import { ChevronDown } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { AssetLogo } from "@/components/brand/marks";
import { useMoney } from "@/components/money/money-provider";
import { Card } from "@/components/ui/card";
import { Row, Rows } from "@/components/ui/row";
import { Section } from "@/components/ui/section";
import type { Holding } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";

import { splitDust } from "./money-groups";
import { OtherTokensDialog, OtherTokensMark } from "./other-tokens";
import { otherTokensLabel } from "./other-tokens-text";

const worth = (holding: Holding) => formatUsdcBalance(BigInt(holding.value.baseUnits));

/** A row that presses: a receipt, a take's move, a fold that opens. */
export function RowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "relative -mx-2 block w-[calc(100%+16px)] rounded-control px-2 text-left outline-none transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/40",
        className,
      )}
      {...props}
    />
  );
}

/** One holding: its logo, what it is and how much, and what it's worth. */
export function HoldingRow({ holding }: { readonly holding: Holding }) {
  return (
    <Row
      mark={<AssetLogo holding={holding} size={32} />}
      title={holding.name}
      meta={holding.detail}
      end={<span className="font-medium tabular-nums">{worth(holding)}</span>}
    />
  );
}

/** Cash on its own: what is ready to use, and any of it still on its way between networks. */
export function CashGroup() {
  const { portfolio } = useMoney();
  if (!portfolio) return null;
  const moving = portfolio.holdings.filter(({ id }) => id === "on-the-way");
  return (
    <Section heading="Cash" aria-label="Cash">
      <Card>
        <Rows className="px-4 sm:px-5">
          <li>
            <Row
              mark={<AssetLogo holding={portfolio.cash} size={32} />}
              title="Cash"
              meta={BigInt(portfolio.cash.value.baseUnits) > 0n ? "Ready to use" : "None yet"}
              end={<span className="font-medium tabular-nums">{worth(portfolio.cash)}</span>}
            />
          </li>
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
              <RowButton aria-expanded={open} onClick={() => setOpen(!open)}>
                <Row
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
                        <span className="font-medium tabular-nums text-muted-foreground">
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
                />
              </RowButton>
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
              <RowButton onClick={() => setTokensOpen(true)}>
                <Row
                  mark={<OtherTokensMark size={32} />}
                  title={otherTokensLabel(uncounted)}
                  meta="Not counted until you add one"
                />
              </RowButton>
            </li>
          ) : null}
        </Rows>
      </Card>
      <OtherTokensDialog open={tokensOpen} onOpenChange={setTokensOpen} />
    </Section>
  );
}
