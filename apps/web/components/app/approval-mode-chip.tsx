"use client";

import type { SpecialistId } from "@auni/shared";
import { Check, Hand, Zap, type LucideIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { ACT_MODE_DETAIL } from "@/components/specialist/manage/dialog-parts";
import { useUpdateSpecialist } from "@/components/specialist/manage/use-specialist-manage";
import { useSpecialist } from "@/components/specialist/use-specialists";
import { usePlaceRoute } from "@/components/places/use-places";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * How Auni gets the go-ahead inside the specialist the person is typing in,
 * from its own rule, or that it's retired. Chats always ask, so they have no chip.
 */
export function ApprovalModeChip() {
  const route = usePlaceRoute();
  if (route.kind !== "specialist") return null;
  return <SpecialistChip id={route.id} />;
}

function SpecialistChip({ id }: { readonly id: SpecialistId }) {
  const { specialist } = useSpecialist(id);
  const update = useUpdateSpecialist(id);
  if (!specialist) return null;
  // A retired one keeps its chat; it just no longer acts, so it says so where its rule was.
  if (specialist.status === "retired") {
    return (
      <span className="flex shrink-0 items-center rounded-full bg-foreground/[0.045] px-3 py-[7px] text-[13.5px] font-medium whitespace-nowrap text-muted-foreground">
        Retired
      </span>
    );
  }
  const auto = specialist.rules.actMode === "within_limits";
  const label = auto ? "Act on its own" : "Ask first";

  const choose = async (next: boolean) => {
    try {
      await update.mutateAsync({ actMode: next ? "within_limits" : "ask_first" });
    } catch {
      toast.error("That change couldn’t be saved. Try again.");
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}. Change how Auni gets your go-ahead.`}
          data-testid="approval-mode-chip"
          data-mode={auto ? "auto" : "ask"}
          disabled={update.isPending}
          className={cn(
            "auni-touch-target flex shrink-0 items-center gap-1.5 rounded-full px-3 py-[7px] text-[13.5px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed data-[state=open]:bg-foreground/[0.075]",
            auto
              ? "bg-primary/[0.08] text-primary hover:bg-primary/[0.12] data-[state=open]:bg-primary/[0.12]"
              : "bg-foreground/[0.045] text-ink-soft hover:bg-foreground/[0.075]",
          )}
        >
          {auto ? (
            <Zap aria-hidden className="size-4" />
          ) : (
            <Hand aria-hidden className="size-4 text-muted-foreground" />
          )}
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[320px] rounded-[16px] border-foreground/[0.08] p-1.5 shadow-menu"
      >
        <div className="px-2.5 pt-2 pb-2.5">
          <p className="text-[14px] font-semibold tracking-[-0.01em] text-ink">
            How Auni gets your go-ahead
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
            For {specialist.name}
          </p>
        </div>
        <DropdownMenuPrimitive.RadioGroup
          value={auto ? "auto" : "ask"}
          onValueChange={(value) => {
            if ((value === "auto") !== auto) void choose(value === "auto");
          }}
        >
          <Option value="ask" icon={Hand} title="Ask first">
            {ACT_MODE_DETAIL.ask_first}
          </Option>
          <Option value="auto" icon={Zap} title="Act on its own">
            {ACT_MODE_DETAIL.within_limits}
          </Option>
        </DropdownMenuPrimitive.RadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Option({
  children,
  icon: Icon,
  title,
  value,
}: {
  readonly children: ReactNode;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly value: string;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      value={value}
      className="flex cursor-default items-start gap-3 rounded-[10px] px-2.5 py-2.5 outline-none select-none focus:bg-foreground/[0.045]"
    >
      <span className="flex size-8 flex-none items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground">
        <Icon aria-hidden className="size-4" strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] leading-5 font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-[1.4] text-muted-foreground">
          {children}
        </span>
      </span>
      <span className="flex size-5 flex-none items-center justify-center self-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden className="size-4 text-ink" strokeWidth={2.4} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  );
}
