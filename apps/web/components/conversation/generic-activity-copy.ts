import { type ConversationToolName, type ToolMeta } from "@auni/shared";
import type { ToolUIPart } from "ai";
import {
  BookOpen,
  Clock,
  Globe,
  Newspaper,
  Search,
  Sparkles,
  TrendingUp,
  Wallet,
  Workflow,
} from "lucide-react";
import type { ComponentType } from "react";

import type { Status } from "@/components/motion/status-mark";
import { APP_TOOLS } from "@/lib/tool-copy";

/**
 * A step's mark: under way while the turn runs it, done once its output is
 * in, failed if it was turned down. A step an ended turn never finished, as
 * when the person stopped it, carries no mark rather than turn forever.
 */
export function toolStepStatus(state: ToolUIPart["state"], live: boolean): Status | null {
  if (state === "output-available") return "done";
  if (state === "output-error" || state === "output-denied") return "failed";
  return live ? "now" : null;
}

export const TOOL_INPUT_DETAIL_KEYS: Partial<Record<string, string>> = {
  WebFetch: "url",
  WebSearch: "query",
  watch: "description",
} satisfies Partial<Record<ConversationToolName, string>>;

type ActivityIcon = ComponentType<{
  readonly "aria-hidden"?: boolean;
  readonly className?: string;
}>;

const ICONS: Record<NonNullable<ToolMeta["icon"]>, ActivityIcon> = {
  search: Search,
  chart: TrendingUp,
  news: Newspaper,
  wallet: Wallet,
  clock: Clock,
};

export const TOOL_ICONS: Partial<Record<string, ActivityIcon>> = {
  ...Object.fromEntries(
    APP_TOOLS.flatMap(([name, tool]) => (tool.icon ? [[name, ICONS[tool.icon]]] : [])),
  ),
  WebFetch: BookOpen,
  WebSearch: Globe,
  watch: Workflow,
  list_watches: Workflow,
  get_portfolio: Wallet,
  get_action: Wallet,
  wait_for_deposit: Wallet,
  list_other_tokens: Wallet,
  add_token: Wallet,
  propose_actions: Wallet,
  retract_cards: Wallet,
  find_instruments: Search,
  start_specialist: Sparkles,
  propose_specialist_portfolio: Sparkles,
  update_specialist: Sparkles,
  get_specialist: Sparkles,
  save_routine: BookOpen,
} satisfies Partial<Record<ConversationToolName, ActivityIcon>>;
