"use client";

import {
  appListing,
  type BrainModelWire,
  type BrainRowWire,
  type ModelSelectionWire,
} from "@auni/shared";
import { Check, ChevronDown, Cpu, ExternalLink } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useMe } from "@/components/personalization/use-me";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buttonVariants } from "@/components/ui/button";
import { useBrains } from "@/lib/data/brains";
import { cn } from "@/lib/utils";

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

type UsableBrain = Extract<BrainRowWire, { readonly state: "ready" | "resting" }>;

function isUsable(row: BrainRowWire): row is UsableBrain {
  return row.state === "ready" || row.state === "resting";
}

function brainLogo(id: string): string | null {
  return appListing(id)?.logo ?? null;
}

function defaultModelFor(brain: UsableBrain): BrainModelWire | undefined {
  return brain.models.find((model) => model.isDefault) ?? brain.models[0];
}

function resolveSelection(
  brains: readonly UsableBrain[],
  picked: ModelSelectionWire | null | undefined,
  fallback: ModelSelectionWire | null | undefined,
): {
  readonly brain: UsableBrain;
  readonly model: BrainModelWire;
  readonly effort: string | undefined;
} | null {
  if (brains.length === 0) return null;
  const preferred = picked ?? fallback ?? null;
  const brain =
    (preferred ? brains.find((entry) => entry.id === preferred.brain) : undefined) ??
    brains.find((entry) => entry.state === "ready") ??
    brains[0]!;
  const model =
    (preferred?.brain === brain.id && preferred.model
      ? brain.models.find((entry) => entry.id === preferred.model)
      : undefined) ?? defaultModelFor(brain);
  if (!model) return null;
  const effort =
    preferred?.brain === brain.id && preferred.effort && model.efforts.includes(preferred.effort)
      ? preferred.effort
      : (model.defaultEffort ?? model.efforts[0]);
  return { brain, model, effort };
}

/**
 * Compact model and reasoning-effort selector inside the composer bar, showing
 * the active AI mark, model name, and softer effort label. Switching updates
 * this thread (or the owner's default on a new thread).
 */
export function ModelPicker({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: ModelSelectionWire | null | undefined;
  readonly onChange: (next: ModelSelectionWire) => void;
  readonly disabled?: boolean;
}) {
  const me = useMe();
  const { openSettings } = useAppDialogs();
  const brainsQuery = useBrains();
  const [open, setOpen] = useState(false);

  const usable = useMemo(
    () => (brainsQuery.data?.rows ?? []).map(({ row }) => row).filter(isUsable),
    [brainsQuery.data],
  );
  const unconnectedCount = (brainsQuery.data?.rows.length ?? 0) - usable.length;
  const active = useMemo(
    () => resolveSelection(usable, value, me.defaultModelSelection),
    [me.defaultModelSelection, usable, value],
  );

  if (!active) return null;

  const logo = brainLogo(active.brain.id);

  const selectModel = (brain: UsableBrain, model: BrainModelWire) => {
    const keepEffort =
      active.effort && model.efforts.includes(active.effort)
        ? active.effort
        : (model.defaultEffort ?? model.efforts[0]);
    onChange({
      brain: brain.id,
      model: model.id,
      ...(keepEffort ? { effort: keepEffort } : {}),
    });
  };

  const selectEffort = (effort: string) => {
    onChange({
      brain: active.brain.id,
      model: active.model.id,
      effort,
    });
  };

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model ${active.model.name}${active.effort ? `, ${effortLabel(active.effort)} effort` : ""}. Change model or effort.`}
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "max-w-[240px] gap-1.5 px-2 data-[state=open]:bg-foreground/[0.06]",
          )}
        >
          {logo ? (
            <Image
              src={logo}
              alt=""
              width={15}
              height={15}
              className="size-[15px] flex-none rounded-full object-contain"
            />
          ) : (
            <Cpu aria-hidden className="size-3.5 flex-none text-muted-foreground" />
          )}
          <span className="truncate font-medium text-ink">{active.model.name}</span>
          {active.effort ? (
            <span className="flex-none text-muted-foreground">{effortLabel(active.effort)}</span>
          ) : null}
          <ChevronDown aria-hidden className="size-3.5 flex-none text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[300px] rounded-card border-foreground/[0.08] p-1.5 shadow-float"
      >
        <div className="flex flex-col gap-1">
          {usable.map((brain) => {
            const mark = brainLogo(brain.id);
            const resting = brain.state === "resting";
            return (
              <div key={brain.id} className="py-1">
                <div className="flex items-center justify-between gap-2 px-2.5 pb-1">
                  <span className="flex items-center gap-1.5 text-caption font-semibold tracking-[0.01em] text-muted-foreground">
                    {mark ? (
                      <Image
                        src={mark}
                        alt=""
                        width={13}
                        height={13}
                        className="size-[13px] flex-none rounded-full object-contain"
                      />
                    ) : null}
                    {brain.name}
                  </span>
                  <span
                    className={cn(
                      "truncate text-caption",
                      resting ? "text-muted-foreground" : "text-faint",
                    )}
                  >
                    {resting ? "Rate limited" : brain.login}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {brain.models.map((model) => {
                    const selected = active.brain.id === brain.id && active.model.id === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => selectModel(brain, model)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-ui transition-colors outline-none hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.045]",
                          selected ? "bg-foreground/[0.045] font-medium text-ink" : "text-ink-soft",
                        )}
                      >
                        <span className="truncate">{model.name}</span>
                        {selected ? (
                          <Check
                            aria-hidden
                            className="size-3.5 flex-none text-ink"
                            strokeWidth={2.4}
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {active.model.efforts.length > 1 ? (
          <div className="mt-1 border-t border-foreground/[0.06] px-2 pt-2.5 pb-1.5">
            <p className="mb-1.5 px-0.5 text-caption font-medium text-muted-foreground">
              Thinking effort
            </p>
            <div
              role="radiogroup"
              aria-label="Thinking effort"
              className="grid gap-1 rounded-control bg-foreground/[0.045] p-1"
              style={{
                gridTemplateColumns: `repeat(${active.model.efforts.length}, minmax(0, 1fr))`,
              }}
            >
              {active.model.efforts.map((effort) => {
                const selected = active.effort === effort;
                return (
                  <button
                    key={effort}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => selectEffort(effort)}
                    className={cn(
                      "flex h-7 items-center justify-center rounded-control text-caption font-medium transition-colors outline-none",
                      selected
                        ? "bg-background text-ink ring-1 ring-border"
                        : "text-muted-foreground hover:text-ink",
                    )}
                  >
                    {effortLabel(effort)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {unconnectedCount > 0 ? (
          <div className="mt-1 border-t border-foreground/[0.06] pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings("brains");
              }}
              className="flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-meta text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-ink"
            >
              <span>Connect another AI</span>
              <ExternalLink aria-hidden className="size-3.5 text-faint" />
            </button>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
