import { APP_LISTINGS, type AutomationWire, type ToolMeta } from "@auni/shared";
import { ChartLine, Clock, Eye, Newspaper, Search, Wallet, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** The glyph for each icon an app's meta may name. */
const TOOL_ICONS: Record<NonNullable<ToolMeta["icon"]>, LucideIcon> = {
  chart: ChartLine,
  news: Newspaper,
  search: Search,
  wallet: Wallet,
  clock: Clock,
};

/** The app that watches, as the web knows it; undefined for one no longer installed. */
export function watchSource(watch: Pick<AutomationWire, "source">) {
  return APP_LISTINGS.find(({ id }) => id === watch.source);
}

/** A watch's kind at a glance, by what its source watches: prices, the news, the time. */
export function WatchIcon({ watch }: { readonly watch: AutomationWire }) {
  const icon = watchSource(watch)?.watchIcon;
  const Icon = icon ? TOOL_ICONS[icon] : Eye;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[34px] flex-none items-center justify-center rounded-[10px]",
        watch.status === "active"
          ? "bg-primary/[0.08] text-primary"
          : "bg-foreground/[0.05] text-muted-foreground",
      )}
    >
      <Icon className="size-[17px]" strokeWidth={1.9} />
    </span>
  );
}
