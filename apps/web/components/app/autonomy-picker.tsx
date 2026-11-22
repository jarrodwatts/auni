"use client";

import type { ThreadActMode } from "@auni/shared";
import { Check, ChevronDown, Hand, Laptop, Zap } from "lucide-react";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useMe } from "@/components/personalization/use-me";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const PRESET_BUDGETS = [100, 250, 500, 1_000] as const;

function formatBudget(usd: string | number): string {
  const n = typeof usd === "number" ? usd : Number(usd);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;
}

/**
 * Thread autonomy selector beneath the composer (right side): works on every
 * thread and on a new thread. Switches between "Ask first" and "Auto" within
 * a dollar spending cap, with a quiet warning when running locally on a laptop.
 */
export function AutonomyPicker({
  actMode,
  budgetUsd,
  freeBudgetUsd,
  threadTitle,
  onChange,
  disabled = false,
}: {
  readonly actMode: ThreadActMode;
  readonly budgetUsd: string;
  readonly freeBudgetUsd?: string | null;
  readonly threadTitle?: string;
  readonly onChange: (next: {
    readonly actMode: ThreadActMode;
    readonly budgetUsd?: string;
  }) => void | Promise<void>;
  readonly disabled?: boolean;
}) {
  const me = useMe();
  const { openSettings } = useAppDialogs();
  const [open, setOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<ThreadActMode>(actMode);
  const [draftBudget, setDraftBudget] = useState(() => {
    const n = Number(budgetUsd);
    return Number.isFinite(n) && n > 0 ? String(n) : "500";
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraftMode(actMode);
      const n = Number(budgetUsd);
      setDraftBudget(Number.isFinite(n) && n > 0 ? String(n) : "500");
    }
    setOpen(nextOpen);
  };

  const auto = actMode === "within_limits";
  const label = auto ? `Auto ${formatBudget(budgetUsd)}` : "Ask first";
  const parsedBudget = Number(draftBudget);
  const validBudget = Number.isFinite(parsedBudget) && parsedBudget > 0 && parsedBudget <= 1_000_000;
  const alwaysOn = me.reach.staysOn.stays;

  const chooseAskFirst = () => {
    setDraftMode("ask_first");
    void onChange({ actMode: "ask_first" });
    setOpen(false);
  };

  const applyAuto = (amount?: number) => {
    const nextBudget = amount ?? parsedBudget;
    if (!Number.isFinite(nextBudget) || nextBudget <= 0) return;
    const formatted = String(nextBudget);
    setDraftMode("within_limits");
    setDraftBudget(formatted);
    void onChange({ actMode: "within_limits", budgetUsd: formatted });
    setOpen(false);
  };

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="autonomy-picker"
          data-mode={auto ? "auto" : "ask"}
          aria-label={`${label}. Change thread spending permissions.`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            auto
              ? "bg-primary/[0.08] font-medium text-primary hover:bg-primary/[0.13] data-[state=open]:bg-primary/[0.13]"
              : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-ink data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-ink",
          )}
        >
          {auto ? (
            <Zap aria-hidden className="size-3.5 flex-none" />
          ) : (
            <Hand aria-hidden className="size-3.5 flex-none text-faint" />
          )}
          <span>{label}</span>
          <ChevronDown aria-hidden className="size-3 flex-none opacity-65" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[332px] rounded-[16px] border-foreground/[0.08] p-2 shadow-menu"
      >
        <div className="px-2 pt-1 pb-2">
          <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink">
            Thread permissions
          </p>
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {threadTitle ?? "Applies when this thread starts"}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={chooseAskFirst}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-[11px] px-2.5 py-2.5 text-left transition-colors outline-none hover:bg-foreground/[0.045]",
              draftMode === "ask_first" && "bg-foreground/[0.045]",
            )}
          >
            <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-full bg-surface text-muted-foreground">
              <Hand aria-hidden className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-ink">Ask first</span>
              <span className="mt-0.5 block text-[12px] leading-[1.4] text-muted-foreground">
                Every move waits for your tap on a card. Nothing spends without you.
              </span>
            </span>
            {actMode === "ask_first" ? (
              <Check aria-hidden className="mt-1 size-4 flex-none text-ink" strokeWidth={2.4} />
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => setDraftMode("within_limits")}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-[11px] px-2.5 py-2.5 text-left transition-colors outline-none hover:bg-foreground/[0.045]",
              draftMode === "within_limits" && "bg-primary/[0.06]",
            )}
          >
            <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-full bg-primary/[0.1] text-primary">
              <Zap aria-hidden className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-ink">Auto within budget</span>
              <span className="mt-0.5 block text-[12px] leading-[1.4] text-muted-foreground">
                Buys and sells stocks, tokens, savings, and market bets inside a dollar cap. Perps,
                bridges, and withdrawals still ask.
              </span>
            </span>
            {actMode === "within_limits" ? (
              <Check aria-hidden className="mt-1 size-4 flex-none text-primary" strokeWidth={2.4} />
            ) : null}
          </button>
        </div>

        {draftMode === "within_limits" ? (
          <div className="mt-2 rounded-[12px] bg-surface p-2.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="auni-auto-budget"
                className="text-[12px] font-medium text-ink-soft"
              >
                Spending budget
              </label>
              {auto && freeBudgetUsd != null ? (
                <span className="text-[11.5px] text-muted-foreground tabular-nums">
                  {formatBudget(freeBudgetUsd)} left of {formatBudget(budgetUsd)}
                </span>
              ) : null}
            </div>

            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {PRESET_BUDGETS.map((preset) => {
                const activePreset = Number(draftBudget) === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setDraftBudget(String(preset))}
                    className={cn(
                      "h-7 rounded-[8px] text-[12px] font-medium tabular-nums transition-colors outline-none",
                      activePreset
                        ? "bg-foreground text-background"
                        : "bg-background text-ink-soft ring-1 ring-foreground/[0.08] hover:text-ink",
                    )}
                  >
                    {formatBudget(preset)}
                  </button>
                );
              })}
            </div>

            <form
              className="mt-2 flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                applyAuto();
              }}
            >
              <div className="relative flex-1">
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-muted-foreground"
                >
                  $
                </span>
                <input
                  id="auni-auto-budget"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={1_000_000}
                  step="any"
                  value={draftBudget}
                  onChange={(event) => setDraftBudget(event.target.value)}
                  className="h-8 w-full rounded-[8px] bg-background pr-2.5 pl-6 text-[13px] text-ink ring-1 ring-foreground/[0.1] outline-none tabular-nums focus:ring-ring"
                />
              </div>
              <button
                type="submit"
                disabled={!validBudget}
                className="h-8 flex-none rounded-[8px] bg-foreground px-3 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {auto ? "Update" : "Turn on"}
              </button>
            </form>

            {!alwaysOn ? (
              <div className="mt-2.5 flex items-start gap-2 rounded-[9px] bg-warning-surface px-2.5 py-2 text-[11.5px] leading-[1.4] text-warning">
                <Laptop aria-hidden className="mt-0.5 size-3.5 flex-none" />
                <span>
                  Running locally on {me.reach.machine}. Auto actions pause when this computer
                  sleeps.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      openSettings("remote");
                    }}
                    className="font-medium underline underline-offset-2"
                  >
                    Keep running 24/7
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
