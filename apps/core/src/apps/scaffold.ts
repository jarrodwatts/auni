import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NETWORK_KEYS } from "@auni/shared";

// What `pnpm scaffold <id> [--with <parts>]` writes (scaffold-cli.ts): a new app's folder that
// core accepts as it stands, with tests of its own that pass, so a contributor changes one real
// thing at a time. Only apps.test.ts fails, while anything Claude reads still says TODO, so an
// unfinished app can't merge looking finished. With no parts it is the smallest app, know-how alone: a SKILL.md.
// Each part is safe as written: its money tool sends nothing, its account owns nothing, its
// reader knows no contract, its wallet signs nothing, its brain is never ready, and its source
// and channel aren't configured, so core leaves them off, until someone writes the part its TODO
// names.

/** The parts an app may have (App in contract.ts), each written from its own template below. */
export const PARTS = [
  "moves",
  "account",
  "reads",
  "lookups",
  "watches",
  "wallet",
  "brain",
  "channel",
  "tokens",
] as const;
export type Part = (typeof PARTS)[number];

/** A folder name: lowercase words joined by dashes, which gen turns into an import name. */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/**
 * Ids core already gives a meaning: a network (a place money sits), the owner's wallet, demo
 * mode (`auni demo`), and each id core files its own moves under. An app named one would be
 * taken for it. Core's moves can't be read here, since loading them needs Auni's settings, so
 * apps.test.ts fails when one is filed under an id this list lacks.
 */
export const RESERVED_IDS: readonly string[] = [
  ...NETWORK_KEYS,
  "wallet",
  "demo",
  "demo-brain",
  "demo-wallet",
  "auni",
  "evm",
  "evm-swap",
  "solana-swap",
  "xstocks",
  "withdrawal",
  "ledger",
  // Auni's own two looks: an app's look is picked, and worn, by its id.
  "light",
  "dark",
];

interface Names {
  /** "my-dex", the folder and about.id. */
  readonly id: string;
  /** "My Dex", what the owner reads until about.ts says better. */
  readonly name: string;
  /** "myDex", for its exports. */
  readonly camel: string;
  /** "MyDex", for an export after a verb ("readMyDex"). */
  readonly pascal: string;
  /** "my_dex", for its tool names. */
  readonly snake: string;
}

function names(id: string): Names {
  const words = id.split("-");
  const upper = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return {
    id,
    name: words.map(upper).join(" "),
    camel: words[0] + words.slice(1).map(upper).join(""),
    pascal: words.map(upper).join(""),
    snake: words.join("_"),
  };
}

/** What one part adds to an app: its files, and its lines in about.ts and index.ts. */
interface Written {
  readonly files: Readonly<Record<string, string>>;
  /** Its import lines in index.ts. */
  readonly imports: readonly string[];
  /** Its member of defineApp({ ... }) in index.ts: "moves: [myDexDeposit]". */
  readonly entry: string;
  /** Its tools, as entries of about.ts's `tools`, by name. */
  readonly tools?: Readonly<Record<string, string>>;
  /** Other lines of about.ts it needs. */
  readonly about?: readonly string[];
}

/** Parts that only work with another: an account says how money gets in, which is a move. */
const NEEDS: Partial<Record<Part, readonly Part[]>> = { account: ["moves"] };

/** Every part an app asking for `asked` has, in the order PARTS lists them. */
const partsOf = (asked: readonly Part[]) =>
  PARTS.filter(
    (part) => asked.includes(part) || asked.some((other) => NEEDS[other]?.includes(part)),
  );

/** The guide beside this file that says how to write each part. */
const GUIDE: Record<Part, string> = {
  moves: "venue.md",
  account: "venue.md",
  reads: "venue.md",
  lookups: "tools.md",
  watches: "source.md",
  wallet: "wallet.md",
  brain: "brain.md",
  channel: "channel.md",
  tokens: "venue.md",
};

/**
 * What to read before filling an app with these parts in: the apps' own page, then each part's
 * guide. An app's folder holds no AGENTS.md of its own: the page above it says the rules, and
 * what the app is goes in its about.ts and its SKILL.md.
 */
export function guidesFor(asked: readonly Part[]): string[] {
  return ["AGENTS.md", ...new Set(partsOf(asked).map((part) => GUIDE[part]))];
}

/**
 * Writes a new app's folder under `appsDir`, refusing one that exists. With `theme` it also
 * brings a look (a theme.css, see theme.ts), which is a file of its own and no part of App.
 */
export async function scaffold(
  id: string,
  parts: readonly Part[],
  appsDir: string,
  { theme = false }: { readonly theme?: boolean } = {},
): Promise<string[]> {
  if (!ID.test(id)) throw new Error(`"${id}" isn't an app id: use lowercase words and dashes.`);
  if (RESERVED_IDS.includes(id))
    throw new Error(`"${id}" is a name core already uses: pick another.`);
  const folder = path.join(appsDir, id);
  if (existsSync(folder)) throw new Error(`apps/${id} already exists.`);
  await mkdir(folder);
  const files = Object.entries(appFiles(id, parts, theme));
  await Promise.all(
    files.map(async ([file, text]) => {
      await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
      await writeFile(path.join(folder, file), text);
    }),
  );
  return files.map(([file]) => path.join(folder, file));
}

/** The files a new app with these parts starts as, by name within its folder. */
function appFiles(id: string, asked: readonly Part[], theme: boolean): Record<string, string> {
  const n = names(id);
  const parts = partsOf(asked);
  const written = parts.map((part) => PART_FILES[part](n));
  // Claude works with it (its tools, its reader, or know-how alone), so it says how in a skill.
  // A look alone is nothing Claude works with.
  const taught = (parts.length === 0 && !theme) || parts.some((part) => TAUGHT.includes(part));
  const tools = Object.assign({}, ...written.map((part) => part.tools ?? {})) as Record<
    string,
    string
  >;
  const entries = [
    ...(taught ? [`guide: "${n.name}: load the ${n.id} skill before working with it."`] : []),
    ...written.map((part) => part.entry),
  ];
  return {
    "about.ts": aboutTs(
      n,
      tools,
      written.flatMap((part) => part.about ?? []),
    ),
    "index.ts": [
      `import { defineApp } from "../contract.ts";`,
      `import about from "./about.ts";`,
      ...written.flatMap((part) => part.imports),
      "",
      `/** ${n.name}: TODO say in a line what it is and what Auni does there. */`,
      `export default defineApp({ ${["about", ...entries].join(", ")} });`,
      "",
    ].join("\n"),
    ...(taught ? { "SKILL.md": skillMd(n, Object.keys(tools)) } : {}),
    ...(theme ? { "theme.css": themeCss(n) } : {}),
    ...Object.assign({}, ...written.map((part) => part.files)),
  };
}

/**
 * A look to start from: Auni's own colours, one token a line, ready to change. It may only set
 * Auni's design tokens under this one selector (theme.ts); `pnpm gen` refuses anything else.
 */
function themeCss(n: Names): string {
  return `/*
 * ${n.name}: a look for Auni. The owner picks it in Settings, under Look.
 * It may only give Auni's design tokens (apps/web/app/tokens.css) other values, under this one
 * selector; a token it leaves out keeps the value of Auni's light look. Every colour in the
 * app comes from a token, so these reach all of it. Run \`pnpm gen\` after you change it, and
 * look at every screen with \`pnpm demo\`.
 */
:root[data-theme="${n.id}"] {
  --background: #ffffff;
  --foreground: #101623;
  --sidebar: #f8f9fb;
  --card: #ffffff;
  --popover: #ffffff;
  --primary: #3d63e0;
  --muted: #f1f3f6;
  --muted-foreground: #535c6b;
  --accent: #f1f3f6;
  --border: #e4e7ec;
  --ring: #3d63e0;
  --ink: #101623;
  --faint: #6b7484;
  --surface: #f5f6f8;
}
`;
}

/** The parts Claude works with, so an app with any of them teaches Claude in a SKILL.md. */
const TAUGHT: readonly Part[] = ["moves", "reads", "lookups"];

function aboutTs(n: Names, tools: Record<string, string>, more: readonly string[]): string {
  const listed = Object.entries(tools).map(([name, tool]) => `    ${name}: ${tool},`);
  return [
    `import type { AppAbout } from "@auni/shared";`,
    "",
    "export default {",
    `  id: "${n.id}",`,
    `  name: "${n.name}",`,
    // Its line in the Apps list: at most 40 characters, with no full stop.
    `  does: "TODO what it does, in a few words",`,
    ...more.map((line) => `  ${line}`),
    ...(listed.length ? ["  tools: {", ...listed, "  },"] : []),
    "} satisfies AppAbout;",
    "",
  ].join("\n");
}

function skillMd(n: Names, tools: readonly string[]): string {
  return `---
name: ${n.id}
description: Load before working with ${n.name}. TODO say when, in the one sentence Claude reads to decide.
---

# ${n.name}

TODO: what Claude should know to work with ${n.name} without working it out again: the steps
that worked, in order, and what goes wrong.
${tools.length ? `\nIts tools: ${tools.map((tool) => `\`${tool}\``).join(", ")}.\n` : ""}`;
}

const PART_FILES: Record<Part, (n: Names) => Written> = {
  moves: (n) => ({
    imports: [
      `import { ${n.camel}Deposit } from "./${n.id}.ts";`,
      `import { problems } from "./problems.ts";`,
    ],
    entry: `moves: [${n.camel}Deposit], problems`,
    tools: {
      [`${n.snake}_deposit`]: `{ kind: "money", copy: ["Preparing your ${n.name} deposit", "Prepared your ${n.name} deposit", "Couldn’t prepare that deposit"], sends: true }`,
    },
    files: {
      "problems.ts": `import type { Problems } from "../contract.ts";

/**
 * What ${n.name} says when it refuses, as the owner should hear it (Problems in ../contract.ts).
 * Add a row for each refusal you meet, with the answer as ${n.name} gave it saved under
 * fixtures/problems/. Where the move reads an answer, throw
 * \`refused(about.name, problems, message)\` (../../money/refused.ts) of what it said, as
 * ../hyperliquid/problems.ts does.
 */
export const problems: Problems = {
  // What went wrong, read from an answer of ${n.name}'s as your code receives it.
  said: (answer) => (answer as { readonly error?: string }).error,
  known: [
    {
      example: "fixtures/problems/short-of-money.json",
      when: /insufficient balance/iu,
      kind: "funds",
      say: "TODO what the owner reads when ${n.name} says this, and what became of their money.",
    },
  ],
};
`,
      "fixtures/problems/short-of-money.json": `${JSON.stringify(
        {
          from: `TODO where this answer came from: recorded from ${n.name}, or the page of its docs that gives it.`,
          answer: { error: "insufficient balance" },
        },
        null,
        2,
      )}\n`,
      [`${n.id}.ts`]: `import { EVM_CASH_KEYS, NETWORKS } from "@auni/shared";
import { z } from "zod";

import type { Recipe } from "../../money/recipe.ts";
import { dollars } from "../../money/summaries.ts";
import { normalizeUsd } from "../../money/usd.ts";

const input = {
  chain: z.enum(EVM_CASH_KEYS).describe("The chain where the USDC already sits."),
  amount_usd: z
    .string()
    .regex(/^\\d+(\\.\\d{1,6})?$/u)
    .describe('USDC amount as a decimal string, e.g. "250" or "12.5".'),
};

/**
 * Puts USDC from the owner's wallet into ${n.name}. Every field is documented in
 * ../../money/recipe.ts, and ../aave/aave.ts is a short, complete recipe to copy from.
 */
export const ${n.camel}Deposit: Recipe<typeof input> = {
  tool: "${n.snake}_deposit",
  venue: "${n.id}",
  // TODO: what the agent reads to pick this tool: what it does, and when it's the right one.
  description: "Put USDC from the owner's wallet into ${n.name} on the same chain.",
  input,
  fundedFrom: ({ input }) => input.chain,
  direction: () => "buy",
  // TODO: what the move is about (Subject in recipe.ts), which its card's picture is drawn from.
  about: () => null,
  async describe({ chain, amount_usd }) {
    const amount = normalizeUsd(amount_usd);
    const network = NETWORKS[chain].name;
    return {
      summary: \`Put \${dollars(amount)} into ${n.name} on \${network}\`,
      amountUsd: amount,
      // What the card shows, and so what the owner allows: execute must do exactly this.
      effect: {
        gives: [{ text: \`\${dollars(amount)} of USDC on \${network}\` }],
        gets: [{ text: \`\${dollars(amount)} in ${n.name}\` }],
        grants: [],
      },
    };
  },
  async execute() {
    // TODO: quote again and refuse anything outside what the card showed
    // (../../money/approved.ts); build the calls, approving exactly what is spent in the same
    // batch; send them with \`wallets\`; and return the transactions and fills. Until then it
    // throws before sending anything, so an allowed card fails and nothing moves.
    throw new Error("${n.name} can't move money yet: its execute isn't written.");
  },
};
`,
      [`${n.id}.test.ts`]: `import { describe, expect, it } from "vitest";

import { approval, effectLines } from "../../money/effect.ts";
import { holdsToCard } from "../../test/held-to-card.ts";
import { ${n.camel}Deposit } from "./${n.id}.ts";

describe("${n.snake}_deposit", () => {
  it("shows what it gives and gets before anything runs, and takes a tap", async () => {
    const preview = await ${n.camel}Deposit.describe(
      { chain: "monad", amount_usd: "25" },
      {},
    );
    expect(preview.amountUsd).toBe("25.00");
    expect(effectLines(preview.effect)).toEqual([
      { label: "You give", value: "$25 of USDC on Monad" },
      { label: "You get", value: "$25 in ${n.name}" },
    ]);
    expect(approval(preview.effect, [])).toEqual({ kind: "tap" });
  });
});

// Every money tool is held to its card by a drill (../../test/held-to-card.ts). Until execute
// sends, this one proves it sends nothing. Once it does, replace it with a full drill, from a
// fake of ${n.name}'s API, that proves what execute signs is exactly what the card shows and that
// it refuses once the world moves past it, as ../aave/aave.held.test.ts does; and add a fork test
// (see CONTRIBUTING.md).
holdsToCard("${n.snake}_deposit", {
  recipe: ${n.camel}Deposit,
  input: { chain: "monad", amount_usd: "25" },
  sendsNothingYet: "its execute isn't written",
});
`,
    },
  }),

  account: (n) => ({
    imports: [`import { ${n.camel}Account } from "./account.ts";`],
    entry: `account: ${n.camel}Account`,
    files: {
      "account.ts": `import type { Account } from "../contract.ts";
import { ${n.camel}Deposit } from "./${n.id}.ts";

/**
 * Where the owner's money sits at ${n.name}, and how it reads in the portfolio. Here, as tokens
 * in the owner's own wallet (a vault's shares): core reads the balance and asks this account
 * what each is worth before any price feed. ../../test/second-venues/vault.ts is a whole one.
 */
export const ${n.camel}Account: Account = {
  // TODO: each token ${n.name} issues the owner, as { chain, instrument, symbol }. Until then it owns none.
  kept: { wallet: [] },
  // TODO: what one is worth now and over time, from ${n.name} itself (a vault's previewRedeem).
  prices: { live: async () => undefined, history: async () => [] },
  face: async (holding) => ({ name: "${n.name}", detail: \`\${holding.quantity} shares\`, logoUrl: null }),
  moneyIn: ${n.camel}Deposit,
  // TODO: the move that takes money out, or plain words on how it comes back to the wallet.
  moneyOut: "Taking money out of ${n.name} isn't written yet; it stays there until it is.",
};
`,
      "account.test.ts": `import { describe, expect, it } from "vitest";

import { ${n.camel}Account } from "./account.ts";
import { ${n.camel}Deposit } from "./${n.id}.ts";

describe("${n.name} account", () => {
  it("owns nothing until it's written, and says how money gets in and out", () => {
    expect(${n.camel}Account.kept).toEqual({ wallet: [] });
    expect(${n.camel}Account.moneyIn).toBe(${n.camel}Deposit);
    expect(typeof ${n.camel}Account.moneyOut).toBe("string");
  });
});
`,
    },
  }),

  reads: (n) => ({
    imports: [`import { ${n.camel}Addresses, read${n.pascal} } from "./reader.ts";`],
    entry: `addresses: ${n.camel}Addresses, reads: read${n.pascal}`,
    files: {
      "reader.ts": `import type { EvmChainKey } from "@auni/shared";

import type { BuiltCall, Reading } from "../contract.ts";

/**
 * ${n.name}'s contracts the owner reaches through it, by lowercased address, on \`chain\`. A
 * transaction Claude builds whose every call goes to one (or approves one) wears ${n.name}'s name. TODO: its contracts, pinned
 * by a test against what the service itself answers (as kyberswap/reader.test.ts pins its router); until then it knows none.
 */
export async function ${n.camel}Addresses(_chain: EvmChainKey): Promise<ReadonlyMap<string, string>> {
  return new Map();
}

/**
 * The few words for a transaction Claude built for ${n.name}, from its calls alone: its title,
 * the layout its verb draws, and a line no simulation shows. Every figure stays the
 * simulation's. TODO: decode the last call with ${n.name}'s ABI; until then it says nothing, and
 * the card is the plain one under ${n.name}'s name.
 */
export function read${n.pascal}(
  _chain: EvmChainKey,
  _calls: readonly BuiltCall[],
): Reading | null {
  return null;
}
`,
      "reader.test.ts": `import { describe, expect, it } from "vitest";

import { ${n.camel}Addresses, read${n.pascal} } from "./reader.ts";

// TODO: for each call it reads, a recorded call and its simulation in, and its words out, as
// kyberswap/reader.test.ts does with a swap its API built and a fork ran.
describe("${n.name} reader", () => {
  it("knows no contract and reads nothing until it's written", async () => {
    expect((await ${n.camel}Addresses("base")).size).toBe(0);
    expect(read${n.pascal}("base", [])).toBeNull();
  });
});
`,
    },
  }),

  lookups: (n) => ({
    imports: [`import { ${n.camel}Lookup } from "./tools.ts";`],
    // TODO: give none while its key is unset, so the agent never sees a tool that can't answer.
    entry: `lookups: () => [${n.camel}Lookup]`,
    tools: {
      [`${n.snake}_lookup`]: `{ kind: "read", copy: ["Looking it up on ${n.name}", "Looked it up on ${n.name}", "Couldn’t look that up"], icon: "search" }`,
    },
    files: {
      "tools.ts": `import { z } from "zod";

import { defineTool, result } from "../../agent/tool.ts";

/**
 * A read-only lookup the agent may call on any turn; its answer reaches the agent as JSON.
 * ../hyperliquid/markets.ts is a real one to copy from.
 */
export const ${n.camel}Lookup = defineTool({
  name: "${n.snake}_lookup",
  // TODO: what it answers, and when the agent should call it.
  description: "Look something up on ${n.name}.",
  inputSchema: { query: z.string().min(1).describe("What to look up.") },
  async handler({ query }) {
    // TODO: ask ${n.name}. Fence any text other people wrote as data, and keep the answer
    // small: the agent reads every word (tools.md).
    return result(JSON.stringify({ query, found: [] }));
  },
});
`,
      "tools.test.ts": `import { describe, expect, it } from "vitest";

import { ${n.camel}Lookup } from "./tools.ts";

describe("${n.snake}_lookup", () => {
  it("answers the agent in JSON", async () => {
    const answer = await ${n.camel}Lookup.handler({ query: "anything" });
    expect(answer.isError).toBeUndefined();
    expect(JSON.parse((answer.content[0] as { text: string }).text)).toEqual({
      query: "anything",
      found: [],
    });
  });
});
`,
    },
  }),

  watches: (n) => ({
    imports: [`import { ${n.camel}Source } from "./source.ts";`],
    entry: `watches: ${n.camel}Source`,
    // The icon beside its watches in the app: chart, clock, news, search or wallet.
    about: [`watchIcon: "search",`],
    files: {
      "source.ts": `import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import type { Source, SourceFire, SourceWatch } from "../contract.ts";

/** How often a run asks ${n.name} about every watch. TODO: as often as the service allows. */
const POLL_MS = 60_000;

/** A watch's condition, in ${n.name}'s own shape: the agent writes to its JSON Schema. */
export const ${n.camel}Condition = z.strictObject({
  // TODO: the fields a condition needs, each with a describe() the agent reads.
  query: z.string().trim().min(1).max(200).describe("What to watch ${n.name} for, in a few words."),
});

/**
 * TODO: ask ${n.name} what came true for this watch after \`after\`, as fires whose \`id\` is the
 * same however often one is told (source.md), with what happened as the \`report\`.
 */
async function firesSince(_watch: SourceWatch, _after: Date): Promise<SourceFire[]> {
  return [];
}

/**
 * Says when a watch's condition came true on ${n.name}. Read source.md first: the hub keeps each
 * watch, records each fire once and decides whether it wakes anyone; a source only says what a
 * condition is and when one came true. ../prices/ runs on this machine; ../elfa/watch.ts is a
 * service that evaluates conditions itself.
 */
export const ${n.camel}Source: Source = {
  // TODO: what it notices and how fast, what a watch costs, and an example condition. The watch
  // tool's description carries it, with the condition's JSON Schema.
  guide: \`${n.name}: TODO say what it can watch for, how quickly it notices, and what each watch costs. A condition is {"query":"what to watch for"}.\`,
  condition: ${n.camel}Condition,
  // TODO: whether its key is set (declare it in about.ts and read it with setting() from ../../settings.ts). Until it says yes, the agent isn't
  // offered it and its run never starts.
  configured: () => false,
  // A poll: each round asks about every watch since the last, and the cursor is when that round
  // began, so a run started again after a restart or a sleep picks up where the last one saved.
  // TODO: mark fires caught up from before this run began \`late\`.
  async *run(context) {
    let after = context.cursor ? new Date(context.cursor) : null;
    while (!context.signal.aborted) {
      const now = new Date();
      const fires = await Promise.all(
        context
          .watches()
          .map((watch) => firesSince(watch, after && after > watch.since ? after : watch.since)),
      );
      yield { fires: fires.flat(), cursor: now.toISOString() };
      after = now;
      await sleep(POLL_MS, undefined, { signal: context.signal }).catch(() => undefined);
    }
  },
};
`,
      "source.test.ts": `import { describe, expect, it } from "vitest";

import type { SourceBatch } from "../contract.ts";
import { ${n.camel}Condition, ${n.camel}Source } from "./source.ts";

// TODO: replay recorded answers from ${n.name} through firesSince and prove each fire is told once,
// as ../prices/run.test.ts does; no test may call the live service.
describe("${n.name} source", () => {
  it("stays off until it's written", () => {
    expect(${n.camel}Source.configured()).toBe(false);
  });

  it("takes the condition its guide describes, and refuses an empty one", () => {
    expect(${n.camel}Condition.parse({ query: "anything" })).toEqual({ query: "anything" });
    expect(${n.camel}Condition.safeParse({}).success).toBe(false);
  });

  it("marks progress with no fires, and stops when asked", async () => {
    const stop = new AbortController();
    const watch = { id: "w1", condition: { query: "anything" }, ref: null, since: new Date() };
    const batches: SourceBatch[] = [];
    for await (const batch of ${n.camel}Source.run({
      watches: () => [watch],
      refresh: async () => [watch],
      cursor: null,
      since: null,
      signal: stop.signal,
    })) {
      batches.push(batch);
      stop.abort();
    }
    expect(batches).toEqual([{ fires: [], cursor: expect.any(String) }]);
  });
});
`,
    },
  }),

  wallet: (n) => ({
    imports: [`import { ${n.camel}Wallet } from "./wallet.ts";`],
    entry: `wallet: ${n.camel}Wallet`,
    files: {
      "wallet.ts": `import type { WalletProvider } from "../contract.ts";

const notYet = (what: string) => new Error(\`${n.name} can't \${what} yet: its wallet isn't written.\`);

/**
 * Where ${n.name} keeps the owner's wallets, and what signs for them. Read wallet.md before
 * writing a line: a signer signs only what core hands it, never logs or returns a key but from
 * revealKeys, and never sends twice. ../local-key/wallet.ts is the whole shape in one place.
 */
export const ${n.camel}Wallet: WalletProvider = {
  // TODO: the owner's addresses once there is a wallet, both null until then, making none.
  async addresses() {
    return { evm: null, solana: null };
  },
  // TODO: make the owner's wallet once, throwing WalletExists when there is one.
  async create() {
    throw notYet("make a wallet");
  },
  async signer() {
    throw notYet("sign");
  },
  // An id it never made is pending, as wallet.md says.
  async sendStatus() {
    return "pending";
  },
  async revealKeys() {
    throw notYet("show keys");
  },
};
`,
      "wallet.test.ts": `import { describe, expect, it } from "vitest";

import { ${n.camel}Wallet } from "./wallet.ts";

describe("${n.name} wallet", () => {
  it("makes, signs and shows nothing until it's written", async () => {
    expect(await ${n.camel}Wallet.addresses()).toEqual({ evm: null, solana: null });
    await expect(${n.camel}Wallet.create()).rejects.toThrow(/isn't written/u);
    await expect(
      ${n.camel}Wallet.signer({ actionId: "a", attempt: 1, onSent: async () => {} }),
    ).rejects.toThrow(/isn't written/u);
    await expect(${n.camel}Wallet.revealKeys()).rejects.toThrow(/isn't written/u);
  });

  it("is used only when WALLET names it", () => {
    expect(${n.camel}Wallet.byDefault).toBeUndefined();
  });
});
`,
    },
  }),

  brain: (n) => ({
    imports: [`import { ${n.camel}Brain } from "./brain.ts";`],
    entry: `brain: ${n.camel}Brain`,
    files: {
      "brain.ts": `import type { Brain } from "../contract.ts";

/**
 * The owner's own ${n.name} CLI, run on this machine with their own login. Read brain.md
 * first: the box it must lock the CLI in matters more than anything else here. ../codex/ is
 * a CLI spoken to over stdio; ../claude-code/ one driven through an SDK.
 */
export const ${n.camel}Brain: Brain = {
  // TODO: whether the CLI is installed and logged in, without a model call, stopping the CLI
  // when the signal aborts. Until then it is never ready, so core never picks it.
  async check() {
    return {
      ready: false,
      why: "not-installed",
      fix: "finish apps/core/src/apps/${n.id}/brain.ts",
    };
  },
  // TODO: spawn the CLI in turn.box with Auni's MCP server, and turn its output into BrainEvents.
  async *run() {
    yield { type: "error", message: "${n.name} can't think yet: its run isn't written." };
  },
  // TODO: the folders and files that hold the CLI's login, which every brain's box hides.
  secrets: () => [],
  // TODO: the command that opens the CLI in the owner's own terminal for \`auni triage\`.
  terminal: () => null,
  // TODO: what its computer can do, as the system prompt says it, and whose models think.
  computer: "no computer of its own yet",
  models: "${n.name}'s models",
};
`,
      "brain.test.ts": `import { describe, expect, it } from "vitest";

import type { BrainEvent, BrainTurn } from "../contract.ts";
import { ${n.camel}Brain } from "./brain.ts";

// TODO: record real turns as fixtures and replay them through a pure events.ts, as
// ../codex/events.test.ts does; no test may call a live AI.
describe("${n.name} brain", () => {
  it("is never picked until it's written", async () => {
    expect(await ${n.camel}Brain.check(new AbortController().signal)).toMatchObject({ ready: false });
  });

  it("ends a turn with exactly one error", async () => {
    const events: BrainEvent[] = [];
    for await (const event of ${n.camel}Brain.run({} as BrainTurn, new AbortController().signal))
      events.push(event);
    expect(events.map(({ type }) => type)).toEqual(["error"]);
  });
});
`,
    },
  }),

  channel: (n) => ({
    imports: [`import { ${n.camel}Channel } from "./channel.ts";`],
    entry: `channel: ${n.camel}Channel`,
    files: {
      "channel.ts": `import type { Channel } from "../contract.ts";

const notYet = (what: string) => new Error(\`${n.name} can't \${what} yet: its channel isn't written.\`);

/**
 * Carries messages between the owner and Auni on ${n.name}. Read channel.md first: core's hub
 * decides who the owner is, which conversation a message joins, and draws every message and
 * button; a channel only carries them. ../telegram/channel.ts is a whole one to copy from.
 */
export const ${n.camel}Channel: Channel = {
  // TODO: whether its token is set (declare it in about.ts and read it with setting() from ../../settings.ts). Until it says yes, the hub leaves
  // it off.
  configured: () => false,
  // TODO: connect outbound (long polling, a websocket), so no public URL is needed, and hand the
  // hub each event in order until \`signal\` aborts, \`from\` being the sender's stable id.
  async listen() {
    throw notYet("listen");
  },
  // TODO: draw the hub's markdown and buttons as ${n.name} can, and return a ref for each message
  // that names the account too, so no other message ever has it.
  async send() {
    throw notYet("send");
  },
  // TODO: replace what a sent message shows, or say false for one it never can edit again.
  async edit() {
    throw notYet("edit");
  },
  // TODO: show the chat that an answer is coming, if ${n.name} can.
  async typing() {},
  // TODO: a link that opens the chat with the code in it, as Telegram's t.me/<bot>?start=<code>.
  async pairingHint() {
    return "${n.name}";
  },
};
`,
      "channel.test.ts": `import { describe, expect, it } from "vitest";

import { ${n.camel}Channel } from "./channel.ts";

// TODO: run it against a fake of ${n.name}'s API, as ../telegram/channel.test.ts does, and pass
// the self-approval table in ../telegram/approvals.db.test.ts; no test may call the live service.
describe("${n.name} channel", () => {
  it("stays off until it's written", () => {
    expect(${n.camel}Channel.configured()).toBe(false);
  });

  it("carries nothing until it's written", async () => {
    const message = { text: "hello" };
    const listening = ${n.camel}Channel.listen(async () => {}, new AbortController().signal);
    await expect(listening).rejects.toThrow(/isn't written/u);
    await expect(${n.camel}Channel.send("chat", message)).rejects.toThrow(/isn't written/u);
    await expect(${n.camel}Channel.edit("ref", message)).rejects.toThrow(/isn't written/u);
  });
});
`,
    },
  }),

  tokens: (n) => ({
    imports: [`import { prices } from "./feed.ts";`],
    entry: `tokens: { prices }`,
    files: {
      "feed.ts": `import type { TokenPrice } from "../../money/history.ts";

/**
 * ${n.name}'s prices by core's price id (see Tokens in ../contract.ts): now, or with \`at\` as they
 * were near then. A token it doesn't price is left out, and it throws when it can't be read,
 * which core shows as a price it couldn't read, never as a loss. It is asked only about tokens
 * no feed listed before it in ../order.ts priced, once its id is added to that list.
 */
export async function prices(
  _ids: readonly string[],
  _at?: Date,
): Promise<ReadonlyMap<string, TokenPrice>> {
  // TODO: ask ${n.name}, translating core's price ids to its own. Then give the role whatever
  // else it has (history, day, listing, logo, listed, stocks), each as ../defillama/,
  // ../lifi/tokens.ts, ../coingecko/ and ../backed/ do.
  return new Map();
}
`,
      "feed.test.ts": `import { expect, it } from "vitest";

import { prices } from "./feed.ts";

// TODO: replay answers recorded from ${n.name} and prove what it prices, what it leaves out, and
// that it throws when it can't be read, as ../defillama/defillama.test.ts does; no test may
// call the live service.
it("prices nothing until it's written", async () => {
  expect((await prices(["coingecko:solana"])).size).toBe(0);
});
`,
    },
  }),
};
