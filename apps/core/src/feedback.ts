import {
  AMOUNT,
  clip,
  RAW_TRANSACTION_TOOLS,
  type FailureKind,
  type Feedback,
  type FeedbackPart,
  withArticle,
} from "@auni/shared";
import { and, asc, eq, inArray } from "drizzle-orm";

import { appById, apps } from "./apps/registry.ts";
import { db } from "./db/client.ts";
import { actions, type ActionRow } from "./db/schema.ts";
import { approvedTokens } from "./money/approved.ts";
import { chainIdOf, evmClient, placeName } from "./money/chains.ts";
import { LINES } from "./money/effect.ts";
import { EVM_NATIVE } from "./money/fill-key.ts";
import { shownHoldings, siteHost } from "./money/raw-transaction.ts";
import { walletAddresses } from "./money/wallets.ts";
import { versionLine } from "./release/layout.ts";
import { coreSecrets, cutLinks, escaped, pieces } from "./safe-words.ts";

// What a feedback card carries (see Feedback in @auni/shared): an app asked for, a bug, an idea.
// The owner posts it themselves as an issue on Auni's GitHub, in public, beside their GitHub name,
// where the one person who maintains Auni reads it. So core builds
// every part here from an allow-list of fields of its own records. The agent gives a name and
// one sentence, which are scrubbed like the rest. Whatever could point at the owner's wallet is
// an optional part, off until they tick it. Their own addresses, amounts, balances, calldata
// arguments and anything from another thread are in no part at all.

type Optional = Feedback["optional"][number];

const WALLET_BESIDE_NAME = "This shows your wallet address beside your GitHub name.";

/**
 * Words safe to post in public, in the order each is cut: every link cut down to its host
 * (`cutLinks`: a node's address can carry its key in its path); anything named a key, a token, a
 * secret or a password, and anything shaped like one (a long run of letters and digits, a chat
 * bot's token), blanked; and anything shaped like an address, a hash or an amount blanked, with
 * its "0x" or without.
 */
const SCRUBBED: readonly (readonly [RegExp, string])[] = [
  [
    /\b([\w-]*(?:key|token|secret|passw(?:or)?d|auth\w*|signature)[\w-]*)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s"',;&}]+/giu,
    "$1$2…",
  ],
  [/\b(bearer|basic)\s+[^\s"',;]+/giu, "$1 …"],
  // A chat bot's token: its id, a colon, its secret.
  [/\b\d{6,}:[\w-]{8,}/gu, "…"],
  // Longer than a function's selector, which says what was called and points at nobody.
  [/0x[0-9a-f]{9,}/giu, "0x…"],
  // The same without its "0x": an address, a padded argument, a key.
  [/\b[0-9a-f]{16,}\b/giu, "…"],
  // A Solana address or signature: base58, 32 characters or more.
  [/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/gu, "…"],
  // Any other long run of letters and digits together, as most keys are.
  [/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{24,}/giu, "…"],
  // Dollars, decimals, long numbers, and a count of a token ("500 USDC", "12 stETH").
  [
    /\$\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*\.\d+\b|\b\d{4,}\b|\b\d[\d,]*(?= ?[a-z]{0,2}[A-Z]{2,6}\b)/gu,
    "#",
  ],
];

export function scrub(text: string): string {
  return SCRUBBED.reduce((kept, [shape, by]) => kept.replace(shape, by), cutLinks(text));
}

/** One sentence the agent wrote, as a part may carry it: scrubbed, on one line, cut to fit. */
const sentence = (text: string) => scrub(text).replace(/\s+/gu, " ").trim().slice(0, 300);

/**
 * What only this owner has, wherever it shows: their wallet's addresses, with their "0x" or
 * without and however they are cased, and the value of every setting this computer holds (an
 * app's keys, core's own, each RPC address and the pieces of its path), however a service
 * echoed it. A value too short to be a key is left, since it could be any word.
 */
async function theirOwn(): Promise<readonly (readonly [string, string])[]> {
  const { evm, solana } = await walletAddresses();
  const addresses = [evm, evm?.slice(2), solana].flatMap((address) => address ?? []);
  return [
    ...addresses.map((address) => [address, "your wallet"] as const),
    ...heldSecrets().map((value) => [value, "…"] as const),
  ];
}

/**
 * The value of every setting this computer holds that could be a secret, and each piece of one
 * that is a link: an app's keys, core's own, each RPC's address. A value too short to be a key is
 * left, since it could be any word.
 */
export function heldSecrets(): string[] {
  const settings = apps().flatMap(({ about }) =>
    Object.values(about.settings ?? {}).flatMap(({ env: name }) => process.env[name] ?? []),
  );
  return [
    ...settings.flatMap((value) => [value, ...pieces(value)]).filter((value) => value.length >= 8),
    ...coreSecrets(),
  ];
}

/** `text` with each of `secrets` in it blanked, the longest first. */
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  return without(
    text,
    secrets.map((value) => [value, "…"] as const),
  );
}

/** `text` with what only this owner has taken out (see theirOwn), longest first. */
function without(text: string, own: readonly (readonly [string, string])[]): string {
  return own
    .toSorted(([a], [b]) => b.length - a.length)
    .reduce((kept, [value, by]) => kept.replace(new RegExp(escaped(value), "giu"), by), text);
}

/** A piece of feedback with nothing of the owner's in any of its words, and no empty part. */
async function finished(feedback: Feedback): Promise<Feedback> {
  const own = await theirOwn();
  const clean = <Part extends FeedbackPart>(parts: readonly Part[]) =>
    parts
      .filter(({ value }) => value.trim() !== "")
      .map((part) => ({ ...part, value: without(part.value, own).slice(0, 4_000) }));
  return {
    ...feedback,
    heading: without(feedback.heading, own),
    title: without(feedback.title, own),
    search: without(feedback.search, own),
    always: clean(feedback.always),
    optional: clean(feedback.optional),
  };
}

/** Where anyone can look a sent transaction up: its chain's explorer, or the chain and its hash. */
function transactionLinks(rows: readonly Pick<ActionRow, "txs">[]): string {
  return rows
    .flatMap(({ txs }) => txs)
    .flatMap(({ chain, hash }) => {
      if (!hash) return [];
      const explorer = explorerOf(chain);
      return [explorer ? `${explorer}/tx/${hash}` : `${placeName(chain)}: ${hash}`];
    })
    .join("\n");
}

/** An EVM chain's own explorer, as viem names it; null for Solana and any chain it names none for. */
function explorerOf(chain: string): string | null {
  try {
    return evmClient(chainIdOf(chain)).chain?.blockExplorers?.default.url ?? null;
  } catch {
    return null;
  }
}

/** The app the agent named on a transaction it built, when no app of Auni's vouched for it. */
function builtFor(row: Pick<ActionRow, "input" | "card">): string | null {
  const name = (row.input as { app?: { name?: unknown } }).app?.name;
  return row.card?.checks && typeof name === "string" ? name : null;
}

/** One transaction that worked, as a maintainer needs it to write the app: never an amount or an argument. */
function step(row: ActionRow): string {
  const { chain } = shownHoldings(row);
  const calls = (row.input as { calls?: { to?: unknown; data?: unknown; value?: unknown }[] })
    .calls;
  const called = Array.isArray(calls)
    ? calls.map(({ to, data, value }) => {
        // The selector alone: the arguments after it can hold the owner's address.
        const selector = typeof data === "string" && data.length >= 10 ? data.slice(0, 10) : null;
        const coin = typeof value === "string" && value !== "0" ? ", sending the chain's coin" : "";
        return `called ${String(to)} with ${selector ?? "no data"}${coin}`;
      })
    : ["a transaction its app's API built"];
  const tokens = approvedTokens(row);
  const named = (list: readonly string[]) =>
    list.map((token) => (token === EVM_NATIVE ? "the chain's own coin" : token)).join(", ") ||
    "none";
  const lets = row.lines.find(({ label }) => label === LINES.lets)?.value;
  const verb = (row.input as { app?: { verb?: unknown } }).app?.verb;
  return [
    `On ${placeName(chain)}: ${called.join(", then ")}.`,
    tokens ? `Tokens sent: ${named(tokens.sends)}.` : null,
    tokens ? `Tokens got: ${named(tokens.gets)}.` : null,
    `Permission left: ${lets ?? "none"}.`,
    typeof verb === "string" ? `The card drew it as: ${verb}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A request for an app for a service Auni has none for. The agent names the service and says
 * what the owner asked for; the chain, and the optional steps and links, come from the
 * transactions it built for that name in this thread that went through.
 */
export async function appRequest(
  threadId: string,
  asked: { readonly name: string; readonly site?: string | undefined; readonly asked: string },
): Promise<Feedback> {
  const name = sentence(asked.name).slice(0, 40) || "a service";
  const site = asked.site ? siteHost(asked.site) : null;
  const done = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.threadId, threadId),
        eq(actions.status, "done"),
        inArray(actions.tool, [...RAW_TRANSACTION_TOOLS]),
      ),
    )
    .orderBy(asc(actions.createdAt));
  const worked = done.filter((row) => builtFor(row)?.toLowerCase() === asked.name.toLowerCase());
  const chains = [...new Set(worked.map((row) => placeName(shownHoldings(row).chain)))];
  const links = transactionLinks(worked);
  return finished({
    kind: "app",
    heading: `Ask for ${withArticle(name)} app`,
    why: "An app would make this read better and work first time, for you and everyone else.",
    title: `App request: ${name}`,
    search: name,
    always: [
      { field: "service", label: "The service", value: name },
      ...(site ? [{ field: "site", label: "Its site", value: site }] : []),
      { field: "asked", label: "What you asked for", value: sentence(asked.asked) },
      ...(chains.length ? [{ field: "chain", label: "Chain", value: chains.join(", ") }] : []),
    ],
    optional: [
      ...(worked.length
        ? [
            {
              field: "steps",
              label: "The steps that worked",
              value: worked.map(step).join("\n\n"),
              warning: "Posted this soon after, they can show which wallet is yours.",
            } satisfies Optional,
          ]
        : []),
      ...(links
        ? [
            {
              field: "transaction",
              label: worked.length > 1 ? "The transaction links" : "The transaction link",
              value: links,
              warning: WALLET_BESIDE_NAME,
            } satisfies Optional,
          ]
        : []),
    ],
  });
}

/** Why a move stopped, by the kind core recorded, as the owner would say it. */
const STOPPED: Record<FailureKind, string> = {
  funds: "There wasn't enough money for it",
  glitch: "A network blip",
  busy: "The service was busy",
  price: "The price moved past what you allowed",
  rule: "The service wouldn't take it as it was",
  stopped: "A move before it didn't go through",
  unfilled: "Nobody filled the order",
  fees: "The coin it bought for its network fee hadn't arrived",
  sent: "It stopped after something may have gone out",
  unknown: "Auni doesn't know yet",
};

/** A tool's id as words: "stock_trade" is "stock trade". */
const toolWords = (tool: string) => tool.replaceAll("_", " ");

/**
 * A failed move as an issue's title names it, with nothing of what the owner traded: the app
 * it ran on, or the tool's own name.
 */
function moveNamed(action: Pick<ActionRow, "tool">, app: string | undefined): string {
  if (app) return `a move on ${app} failed`;
  return (RAW_TRANSACTION_TOOLS as readonly string[]).includes(action.tool)
    ? "a transaction Auni built failed"
    : `${toolWords(action.tool)} failed`;
}

/**
 * What a failed move was, as its own card named it, less its dollars: "Buy COIN". Only the
 * owner reads it, on their own screen; what is posted is the tool's id.
 */
function tried(action: Pick<ActionRow, "card" | "tool">): string {
  const title = action.card?.title
    .replace(` for ${AMOUNT}`, "")
    .replace(AMOUNT, "")
    .replace(/\s+/gu, " ")
    .trim();
  return (title || toolWords(action.tool)).slice(0, 200);
}

/**
 * A report of something broken: about a move that failed (`action`), about an app, or neither.
 * `happened` is the agent's sentence when a turn is behind it; a report the owner starts from
 * a failed card or an app's sheet has none, and they say what happened on GitHub.
 */
export async function bugReport(about: {
  readonly happened?: string | undefined;
  readonly action?: ActionRow | undefined;
  readonly app?: string | undefined;
}): Promise<Feedback> {
  const { action } = about;
  const app = appById(action?.venue ?? about.app ?? "");
  // The app's own sentence for a refusal it knows is fixed words, safe to post as they are.
  const known = app?.problems?.known.some(({ say }) => say === action?.error) ?? false;
  const links = action ? transactionLinks([action]) : "";
  const happened = about.happened ? sentence(about.happened) : null;
  // What went wrong names it, where a sentence says: an app's name alone ("Bug: <the app>")
  // tells the maintainer nothing in a list of issues, and the app has its own line. Cut at a
  // word, so the title GitHub gets and the card shows never ends mid-word.
  const subject =
    (action ? moveNamed(action, app?.about.name) : null) ??
    (happened ? clip(happened, 80) : null) ??
    app?.about.name ??
    "Auni";
  return finished({
    kind: "bug",
    heading: `Report a problem with ${app?.about.name ?? "Auni"}`,
    why: "Auni's maintainer gets the facts needed to find it, and nothing about your money.",
    title: `Bug: ${subject}`,
    search: app?.about.name ?? action?.tool ?? "bug",
    always: [
      ...(happened ? [{ field: "happened", label: "What happened", value: happened }] : []),
      ...(app ? [{ field: "app", label: "App", value: app.about.name }] : []),
      ...(action
        ? [
            { field: "tool", label: "What Auni tried", value: action.tool, reads: tried(action) },
            {
              field: "failure",
              label: "Why it stopped",
              value: action.failureKind ?? "unknown",
              reads: STOPPED[action.failureKind ?? "unknown"],
            },
            ...(known ? [{ field: "said", label: "What Auni said", value: action.error! }] : []),
            { field: "tries", label: "Tries", value: String(action.attempts) },
          ]
        : []),
      { field: "version", label: "Auni's version", value: versionLine() },
    ],
    optional: [
      ...(action?.error && !known
        ? [
            {
              field: "error",
              label: "The error as it came",
              value: scrub(action.error),
              warning:
                "Links are cut to their site, and addresses and amounts are blanked. Read it before you tick it.",
            } satisfies Optional,
          ]
        : []),
      ...(links
        ? [
            {
              field: "transaction",
              label: "The transaction link",
              value: links,
              warning: WALLET_BESIDE_NAME,
            } satisfies Optional,
          ]
        : []),
    ],
  });
}

/** Something the owner would like Auni to do, in the agent's sentence. */
export async function idea(says: string): Promise<Feedback> {
  return finished({
    kind: "idea",
    heading: "Suggest it for Auni",
    why: "Auni is open source, so an idea posted there can be picked up by anyone.",
    title: `Idea: ${clip(sentence(says), 80)}`,
    search: sentence(says).slice(0, 60),
    always: [
      { field: "idea", label: "The idea", value: sentence(says) },
      { field: "version", label: "Auni's version", value: versionLine() },
    ],
    optional: [],
  });
}
