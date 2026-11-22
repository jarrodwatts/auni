import {
  APP_LATER_TOOLS,
  APP_MONEY_TOOLS,
  APP_READ_TOOLS,
  APP_RECORDED_TOOLS,
} from "./apps.generated.ts";

/**
 * Every tool core registers for the agent, by the name the agent calls it. Core
 * types each tool's name against these lists (and a test checks it registers
 * exactly them), so web can key its copy and icons off them: a tool added in
 * core without its copy on the web is a type error there, not a silent fallback.
 */

/**
 * Tools that move money: each call records an action behind the permission
 * gate. Auni's own, then each app's (see apps.generated.ts).
 */
export const MONEY_TOOL_NAMES = [
  "evm_swap",
  "solana_swap",
  "stock_trade",
  "send_evm_transaction",
  "send_solana_transaction",
  "withdraw_usdc",
  ...APP_MONEY_TOOLS,
] as const;
export type MoneyToolName = (typeof MONEY_TOOL_NAMES)[number];

/**
 * Every move an action records: a money tool's, or one the agent never calls: convert_to_cash,
 * which code puts on a card that pays with a holding, to turn that holding into USDC on the tap,
 * and an app's moves a card's tap allows for later (its "later" tools).
 */
export const ACTION_TOOL_NAMES = [
  ...MONEY_TOOL_NAMES,
  "convert_to_cash",
  ...APP_LATER_TOOLS,
] as const;
export type ActionToolName = (typeof ACTION_TOOL_NAMES)[number];

/**
 * What a venue did by itself and Auni read from its records afterwards, each
 * recorded as a done action under one of these (an app's "recorded" tools):
 * Polymarket paying out a resolved market, or a Hyperliquid trade no order of
 * Auni's made (a liquidation, auto-deleveraging, a trade in Hyperliquid's own
 * app). No one asked for them, so no card ever shows one as a move to allow.
 */
export const VENUE_TOOL_NAMES = APP_RECORDED_TOOLS;
export type VenueToolName = (typeof VENUE_TOOL_NAMES)[number];

/** Whether a recorded action is something a venue did by itself (see VENUE_TOOL_NAMES). */
export function isVenueTool(tool: string): tool is VenueToolName {
  return (VENUE_TOOL_NAMES as readonly string[]).includes(tool);
}

/**
 * Tools that send a transaction the agent built, which take proof the owner is
 * at the computer unless core's simulation of it says a tap is enough.
 */
export const RAW_TRANSACTION_TOOLS: readonly string[] = [
  "send_evm_transaction",
  "send_solana_transaction",
] satisfies MoneyToolName[];

/**
 * Tools whose call asks to change Auni itself, not money: each records an action row that waits
 * for the owner's Allow like a money card, and applies only on it (see asks.ts in core).
 */
export const ASK_TOOL_NAMES = [
  "set_thread_autonomy",
  "save_routine",
  "connect_app",
  "request_secret",
] as const;
export type AskToolName = (typeof ASK_TOOL_NAMES)[number];

/** Whether a recorded action is an ask rather than a money move. */
export function isAsk(tool: string): tool is AskToolName {
  return (ASK_TOOL_NAMES as readonly string[]).includes(tool);
}

export const AUNI_TOOL_NAMES = [
  ...MONEY_TOOL_NAMES,
  ...APP_READ_TOOLS,
  // Reading & money planning
  "find_instruments",
  "get_portfolio",
  "get_action",
  "wait_for_deposit",
  "list_other_tokens",
  "add_token",
  "propose_actions",
  "retract_cards",
  // Watching
  "watch",
  "list_watches",
  // Thread & working
  "set_thread_autonomy",
  "update_thread_notes",
  "settle_quietly",
  "set_notices",
  "show_brief",
  "name_chat",
  "suggest_replies",
  "load_skill",
  "save_routine",
  "connect_app",
  "request_secret",
  "send_feedback",
  "inspect_auni",
  "update_auni_preferences",
  "read_chain",
  "fetch_url",
] as const;
export type AuniToolName = (typeof AUNI_TOOL_NAMES)[number];

/** A tool an app gives the agent, whose copy and icon come from its meta. */
export type AppToolName = (typeof APP_MONEY_TOOLS)[number] | (typeof APP_READ_TOOLS)[number];

/**
 * The brain's own tools, by the names Claude Code gives them (every brain maps its own onto
 * these): its computer (shell, files, planning) and the web. Older transcripts carry the rest,
 * and a future CLI may add more, so a transcript can still carry a name outside this list.
 */
export type SdkToolName =
  | "Agent"
  | "Bash"
  | "Edit"
  | "Glob"
  | "Grep"
  | "Read"
  | "Skill"
  | "Task"
  | "TaskCreate"
  | "TaskGet"
  | "TaskList"
  | "TaskOutput"
  | "TaskStop"
  | "TaskUpdate"
  | "TodoWrite"
  | "ToolSearch"
  | "WebFetch"
  | "WebSearch"
  | "Write";

/** A tool call a conversation can show. */
export type ConversationToolName = AuniToolName | SdkToolName;
