"use client";

import { Hand, PiggyBank, Zap, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ACT_MODE_DETAIL } from "@/components/specialist/manage/dialog-parts";
import type { Specialist } from "@/lib/data/views";
import { formatUsd } from "@/lib/money";

const FACT =
  "flex h-8 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-ink-soft";

/**
 * How a specialist runs, in one quiet strip: how Auni acts for it, which opens where it
 * changes, and its pot, the money behind it, which changes in its chat (a card the owner allows).
 * Chat edits the same things, so the strip follows.
 */
export function SpecialistFacts({
  specialist,
  onActs,
}: {
  readonly specialist: Specialist;
  readonly onActs: () => void;
}) {
  const asks = specialist.rules.actMode === "ask_first";
  const acts = asks ? "Asks first" : "Acts on its own";
  const pot = Number(specialist.potUsd) > 0 ? formatUsd(specialist.potUsd) : null;

  return (
    <div className="flex h-10 w-full items-center rounded-full bg-foreground/[0.04] p-1">
      <button
        type="button"
        aria-haspopup="dialog"
        title={ACT_MODE_DETAIL[specialist.rules.actMode]}
        aria-label={`How Auni acts: ${acts}. Change`}
        onClick={onActs}
        className={`${FACT} transition-colors duration-200 hover:bg-foreground/[0.05] hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none`}
      >
        {glyph(asks ? Hand : Zap)}
        <span className="truncate">{acts}</span>
      </button>
      {pot ? (
        <>
          <span aria-hidden className="h-4 w-px flex-none bg-foreground/[0.09]" />
          <Fact icon={glyph(PiggyBank)} title="Its pot: ask in its chat to change it">
            {pot} pot
          </Fact>
        </>
      ) : null}
    </div>
  );
}

function glyph(Icon: LucideIcon) {
  return <Icon aria-hidden className="size-3.5 flex-none text-faint" strokeWidth={2} />;
}

function Fact({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <span title={title} className={FACT}>
      {icon}
      <span className="truncate tabular-nums">{children}</span>
    </span>
  );
}
