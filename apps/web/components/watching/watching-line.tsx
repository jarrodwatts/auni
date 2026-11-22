"use client";

import type { AutomationRuleId, ThreadId } from "@auni/shared";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Mascot } from "@/components/brand/mascot";
import { cn } from "@/lib/utils";

import { useWatches } from "./use-watches";
import { WatchSheet } from "./watch-sheet";

/**
 * Everything the agent set up to watch in one answer, as one line under its
 * words (which already say what each watch is), led by Auni listening, or
 * greyed out once they're all paused. It opens the watch sheet.
 */
export function WatchingLine({
  threadId,
  automationIds,
}: {
  readonly threadId: ThreadId;
  readonly automationIds: readonly AutomationRuleId[];
}) {
  const [open, setOpen] = useState(false);
  const scope = { threadId };
  const watches = useWatches(scope).data;
  const mine = watches?.filter(({ id }) => automationIds.includes(id));
  const on = mine ? mine.filter(({ status }) => status === "active") : null;
  const only = automationIds.length === 1 ? mine?.[0] : undefined;
  const label =
    on === null
      ? `Watching ${automationIds.length === 1 ? "1 thing" : `${automationIds.length} things`}`
      : on.length === 0
        ? automationIds.length === 1
          ? "Not watching this now"
          : "Not watching these now"
        : only
          ? `Watching: ${only.description}`
          : `Watching ${on.length === 1 ? "1 thing" : `${on.length} things`}`;

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex h-10 max-w-full items-center gap-[7px] self-start rounded-full border border-foreground/[0.08] bg-card pr-3 pl-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-foreground/[0.03] focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        <Mascot
          alt=""
          size={24}
          state={on?.length === 0 ? "color" : "listening"}
          className={cn("flex-none", on?.length === 0 && "opacity-55 grayscale")}
        />
        <span className="truncate">{label}</span>
        <ChevronRight aria-hidden className="size-3.5 flex-none text-faint" />
      </button>
      <WatchSheet scope={scope} open={open} onOpenChange={setOpen} />
    </>
  );
}
