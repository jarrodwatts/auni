import {
  type AuniToolName,
  APP_LISTINGS,
  type AppToolName,
  type SdkToolName,
  type ToolMeta,
} from "@auni/shared";
import type { ToolUIPart } from "ai";

/** What a step says, and whether it shows at all, for every tool a conversation can carry. */

interface ToolActivityCopy {
  readonly running: string;
  readonly completed: string;
  readonly failed: string;
}

function copy(running: string, completed: string, failed: string): ToolActivityCopy {
  return { running, completed, failed };
}

/** Any tool this table has not met yet still reads as plain work, never as a tool name. */
const FALLBACK_ACTIVITY_COPY = copy("Working on this", "Worked on this", "Hit a snag");

/**
 * Never shown as a step: a tool that only hands the thread something to draw (suggest_replies
 * draws the reply chips), and the agent's own work (skills, chain reads, pages, its computer),
 * which is how it thinks rather than what it did for you.
 */
const SILENT = "silent";

/**
 * What each of core's own tools is doing, in the person's words, present tense
 * while it runs, or that it never shows. Every tool core registers needs its
 * line. An app's tools say theirs in its meta.
 */
const AUNI_TOOL_COPY: Record<
  Exclude<AuniToolName, AppToolName>,
  ToolActivityCopy | typeof SILENT
> = {
  suggest_replies: SILENT,
  load_skill: SILENT,
  read_chain: SILENT,
  fetch_url: SILENT,
  // Reading
  find_instruments: copy(
    "Finding the right picks",
    "Found some picks",
    "Couldn’t search the markets",
  ),
  get_portfolio: copy("Checking your money", "Checked your money", "Couldn’t check your money"),
  get_action: copy("Checking on your move", "Checked on your move", "Couldn’t check on it"),
  // It shows where to send money and wakes the thread on arrival; done means the card is up,
  // not that the money landed.
  wait_for_deposit: copy(
    "Getting your address ready",
    "Showed where to send your money",
    "Couldn’t show where to send your money",
  ),
  list_other_tokens: copy(
    "Checking your other tokens",
    "Checked your other tokens",
    "Couldn’t check your other tokens",
  ),
  add_token: copy("Adding your token", "Added your token", "Couldn’t add that token"),
  propose_actions: copy(
    "Putting your moves together",
    "Put your moves together",
    "Couldn’t put those moves together",
  ),
  retract_cards: copy("Taking back a card", "Took back a card", "Couldn’t take that card back"),
  // Specialists
  start_specialist: copy(
    "Proposing a specialist",
    "Proposed a specialist",
    "Couldn’t propose that specialist",
  ),
  propose_specialist_portfolio: copy(
    "Putting your picks together",
    "Put your picks together",
    "Couldn’t put those picks together",
  ),
  update_specialist: copy(
    "Updating your specialist",
    "Updated your specialist",
    "Couldn’t update your specialist",
  ),
  get_specialist: copy(
    "Looking over your specialist",
    "Looked over your specialist",
    "Couldn’t read your specialist",
  ),
  // Moves: each prepares a card that waits for the person's OK, so done means prepared.
  stock_trade: copy("Preparing your order", "Prepared your order", "Couldn’t prepare that order"),
  evm_swap: copy("Preparing your trade", "Prepared your trade", "Couldn’t prepare that trade"),
  solana_swap: copy("Preparing your trade", "Prepared your trade", "Couldn’t prepare that trade"),
  send_evm_transaction: copy(
    "Preparing a transfer",
    "Prepared a transfer",
    "Couldn’t prepare that transfer",
  ),
  send_solana_transaction: copy(
    "Preparing a transfer",
    "Prepared a transfer",
    "Couldn’t prepare that transfer",
  ),
  withdraw_usdc: copy(
    "Preparing a withdrawal",
    "Prepared a withdrawal",
    "Couldn’t prepare that withdrawal",
  ),
  move_holding: copy(
    "Preparing to move a holding",
    "Prepared to move a holding",
    "Couldn’t prepare that move",
  ),
  // Watching
  watch: copy("Changing what I watch", "Changed what I watch", "Couldn’t change what I watch"),
  list_watches: copy(
    "Checking what I’m watching",
    "Checked what I’m watching",
    "Couldn’t check what I’m watching",
  ),
  // Working
  settle_quietly: copy(
    "Deciding it can wait",
    "Nothing worth telling you",
    "Couldn’t settle this quietly",
  ),
  set_notices: copy(
    "Checking how I keep you posted",
    "Set how I keep you posted",
    "Couldn’t change how I keep you posted",
  ),
  show_brief: copy(
    "Reading what your brief would say",
    "Read what your brief would say",
    "Couldn’t read your brief",
  ),
  // Naming the chat is housekeeping: the new name shows in History.
  name_chat: SILENT,
  save_routine: copy("Writing up a routine", "Wrote up a routine", "Couldn’t write that routine"),
  connect_app: copy("Offering an app", "Offered an app", "Couldn’t offer that app"),
  request_secret: copy("Asking for it", "Asked for it", "Couldn’t ask for that"),
  send_feedback: copy("Writing it up", "Wrote it up", "Couldn’t write that up"),
  inspect_auni: copy("Checking Auni’s setup", "Checked Auni’s setup", "Couldn’t read Auni’s setup"),
  update_auni_preferences: copy(
    "Updating your settings",
    "Updated your settings",
    "Couldn’t update your settings",
  ),
};

/** The brain's own tools: the web shows as steps, its computer never does. */
const SDK_TOOL_COPY: Record<SdkToolName, ToolActivityCopy | typeof SILENT> = {
  WebFetch: copy("Reading a page", "Read a page", "Couldn’t read the page"),
  WebSearch: copy("Searching the web", "Searched the web", "Couldn’t search the web"),
  Agent: SILENT,
  Bash: SILENT,
  Edit: SILENT,
  Glob: SILENT,
  Grep: SILENT,
  Read: SILENT,
  Skill: SILENT,
  Task: SILENT,
  TaskCreate: SILENT,
  TaskGet: SILENT,
  TaskList: SILENT,
  TaskOutput: SILENT,
  TaskStop: SILENT,
  TaskUpdate: SILENT,
  TodoWrite: SILENT,
  ToolSearch: SILENT,
  Write: SILENT,
};

/** Every app's tools, by name, as its meta describes them. */
export const APP_TOOLS: readonly (readonly [string, ToolMeta])[] = APP_LISTINGS.flatMap(
  ({ tools }) => Object.entries(tools ?? {}),
);

const APP_TOOL_COPY: Partial<Record<string, ToolActivityCopy>> = Object.fromEntries(
  APP_TOOLS.flatMap(([name, tool]) => (tool.copy ? [[name, copy(...tool.copy)]] : [])),
);

const TOOL_ACTIVITY_COPY: Partial<Record<string, ToolActivityCopy | typeof SILENT>> = {
  ...AUNI_TOOL_COPY,
  ...APP_TOOL_COPY,
  ...SDK_TOOL_COPY,
};

/**
 * A tool's words, or that it never shows as a step. Read by whatever name a transcript carries,
 * which may be a tool this build doesn't know yet: that one shows, as plain work.
 */
export function toolCopy(toolName: string): ToolActivityCopy | typeof SILENT {
  return TOOL_ACTIVITY_COPY[toolName] ?? FALLBACK_ACTIVITY_COPY;
}

/** A shown step's words for where it got to: present tense while it runs, past once done. */
export function toolActivityTitle(toolName: string, state: ToolUIPart["state"]): string {
  const found = toolCopy(toolName);
  const copy = found === SILENT ? FALLBACK_ACTIVITY_COPY : found;
  if (state === "output-available") return copy.completed;
  if (state === "output-error" || state === "output-denied") return copy.failed;
  return copy.running;
}
