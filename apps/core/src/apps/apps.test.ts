import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { NETWORK_KEYS, type AppAbout, type ToolMeta } from "@auni/shared";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { env } from "../env.ts";
import { fillIdentity } from "../money/fill-key.ts";
import { everyRecipe } from "../money/recipes/index.ts";
import { ownedBy } from "../settings.ts";
import { expectKindsKept, expectOwnOnlyTheirOwn } from "../test/venue-rules.ts";
import type { App } from "./contract.ts";
import { ASKED_FIRST } from "./order.ts";
import { RESERVED_IDS } from "./scaffold.ts";
import {
  accountOwning,
  accounts,
  factSources,
  filling,
  firstBridge,
  hasSwitch,
  ledgerAt,
  appRecipes,
  apps,
  offered,
  sources,
  theWallet,
} from "./registry.ts";

// What each venue's holdings read, so they can be read with no network: one perp and one
// outcome, and nothing else anywhere.
vi.mock("./hyperliquid/account.ts", async (original) => ({
  ...(await original<typeof import("./hyperliquid/account.ts")>()),
  readAccount: vi.fn(async () => ({
    spot: { balances: [{ coin: "USDC", total: "5.0", hold: "0.0" }] },
    dexes: [
      {
        withdrawable: "0.0",
        marginSummary: { accountValue: "10.0" },
        assetPositions: [
          {
            position: {
              coin: "xyz:NVDA",
              szi: "-0.5",
              entryPx: "180.0",
              liquidationPx: null,
              unrealizedPnl: "0.0",
              marginUsed: "10.0",
              leverage: { value: 3 },
            },
          },
        ],
      },
    ],
  })),
}));
vi.mock("./polymarket/wallet.ts", async (original) => ({
  ...(await original<typeof import("./polymarket/wallet.ts")>()),
  depositWallet: vi.fn(async () => ({ address: `0x${"2".repeat(40)}`, deployed: true })),
}));
vi.mock("../money/chains.ts", async (original) => ({
  ...(await original<typeof import("../money/chains.ts")>()),
  // No cash in any token, and four of each outcome's shares, as its holdings read them.
  publicClient: () => ({
    readContract: async ({ args }: { args: readonly unknown[] }) =>
      args.length === 2 ? 4_000_000n : 0n,
  }),
}));

/**
 * An app core's money runs through or is read by: one with a money tool of its own or an
 * account, or one that fills a role core asks (a route, a bridge, a pay-in, a token feed).
 */
const coreAsks = (app: App) =>
  Boolean(
    app.moves || app.account || app.swaps || app.solana || app.bridge || app.payIn || app.tokens,
  );

const toolsOfKind = (tools: AppAbout["tools"], kind: ToolMeta["kind"]) =>
  Object.entries(tools ?? {})
    .flatMap(([name, tool]) => (tool.kind === kind ? [name] : []))
    .toSorted();

/** An app's own SKILL.md, or null. */
const skillOf = (id: string): string | null => {
  const file = join(dirname(fileURLToPath(import.meta.url)), id, "SKILL.md");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

// The four hard parts of an app, each answered in its folder, and each failing here when an
// app that needs it skips it (AGENTS.md beside this file).
describe("the four answers an app gives", () => {
  it("money in and out: an account says both, with its own moves or in words", () => {
    for (const { about, moves, account, bridge } of apps()) {
      // An app that moves money keeps it somewhere, unless it only carries it between chains.
      if (moves?.length && !bridge)
        expect(account, `${about.id} has moves and no account`).toBeDefined();
      if (!account) continue;
      for (const way of [account.moneyIn, account.moneyOut])
        if (typeof way !== "string") expect(moves, about.id).toContain(way);
        else expect(way.trim().length, about.id).toBeGreaterThan(20);
      const out = account.moneyOut;
      // What takes money out lands it in a wallet, or sells.
      if (typeof out !== "string")
        expect(Boolean(out.readies) || out.direction?.({} as never) === "sell", about.id).toBe(
          true,
        );
      // Money into a ledger lands on that ledger.
      if (typeof account.kept === "object" && "ledger" in account.kept) {
        const into = account.moneyIn;
        expect(typeof into === "string" ? about.id : into.readies?.({} as never), about.id).toBe(
          about.id,
        );
      }
    }
  });

  it("money in and out: a move that spends from an app's own place has a ledger there", () => {
    for (const { about, moves } of apps())
      for (const move of moves ?? []) {
        let from: string | null | undefined;
        try {
          from = move.fundedFrom?.({ input: {} as never, details: {} });
        } catch {
          from = undefined;
        }
        if (from === about.id) expect(ledgerAt(about.id), move.tool).toBeDefined();
      }
  });

  it("things going wrong: an app with moves says each refusal it knows in the owner's words", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const { about, moves, problems } of apps()) {
      if (moves?.length)
        expect(problems?.known.length ?? 0, `${about.id} has moves and knows no refusal`).not.toBe(
          0,
        );
      (problems?.known ?? []).forEach(({ example, say }, index) => {
        const which = `${about.id}: ${example}`;
        const { from, answer } = JSON.parse(
          readFileSync(join(here, about.id, example), "utf8"),
        ) as {
          readonly from: string;
          readonly answer: unknown;
        };
        // Where the answer came from: the service itself, or the page of its docs that gives it.
        expect(from.length, which).toBeGreaterThan(40);
        // Read as a live answer is, it is this refusal and no earlier one.
        const said = problems!.said(answer);
        expect(said, `${which} refuses nothing`).toBeDefined();
        expect(
          problems!.known.findIndex(({ when }) => when.test(said!)),
          `${which} is "${said}"`,
        ).toBe(index);
        // A sentence the web shows as it is (readableError in its move-rows.ts), for the owner:
        // it names no tool, and the owner is never "the user".
        expect(say, which).toMatch(/^[A-Z][^{}[\]]{0,198}\.$/u);
        expect(say, which).not.toMatch(/\bthe user\b|\b[a-z]+_[a-z_]+\b/u);
      });
    }
  });

  it("teaching Claude: an app with tools or a reader has a skill that names each of its tools", () => {
    for (const { about, moves, lookups, reads } of apps()) {
      const skill = skillOf(about.id);
      if (!moves?.length && !lookups && !reads && !skill) continue;
      expect(skill, `${about.id} has no SKILL.md`).not.toBeNull();
      expect(skill, about.id).toMatch(
        new RegExp(`^---\\nname: ${about.id}\\ndescription: .{20,}`, "u"),
      );
      const tools = [...toolsOfKind(about.tools, "money"), ...toolsOfKind(about.tools, "read")];
      for (const tool of tools) expect(skill, `${about.id}'s skill names ${tool}`).toContain(tool);
    }
  });

  it("teaching Claude: nothing Claude reads of an app is still the scaffold's TODO", () => {
    // pnpm scaffold marks every word Claude reads that it can't write itself, so an app starts
    // here as the one failing check, and can't merge looking finished with TODO in Claude's view.
    for (const { about, guide, moves, lookups, watches, problems } of apps()) {
      const read = [
        skillOf(about.id),
        // Its line in the Apps list, which Claude is told when the app would help (connect.ts).
        about.does,
        guide,
        watches?.guide,
        // A refusal's words are the move's error, which Claude is told as the owner is.
        ...(problems?.known ?? []).map(({ say }) => say),
        ...(moves ?? []).flatMap(({ description }) =>
          typeof description === "string"
            ? [description]
            : [description({ solana: true }), description({ solana: false })],
        ),
        ...(lookups?.() ?? []).map((tool) => tool.description),
      ];
      for (const words of read)
        expect(words ?? "", `${about.id} still says TODO where Claude reads it`).not.toMatch(
          /\bTODO\b/u,
        );
    }
  });
});

describe("apps", () => {
  it("each have an id of their own, and none core already gives a meaning", () => {
    const ids = apps().map(({ about }) => about.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of RESERVED_IDS) expect(ids).not.toContain(id);
  });

  // A move is filed under its app's id, and core's own under ids of core's. An app named one
  // of those would have its moves taken for core's, so the scaffold refuses each: read here
  // from core's recipes, which the scaffold can't load.
  it("leave core every id it files its own moves under", () => {
    const theirs = new Set(appRecipes());
    const cores = everyRecipe().flatMap((recipe) => (theirs.has(recipe) ? [] : [recipe.venue]));
    expect(cores).toEqual(expect.arrayContaining(["evm", "xstocks", "withdrawal"]));
    for (const venue of cores) expect(RESERVED_IDS, venue).toContain(venue);
  });

  // The web takes each tool's copy, icon and kind from meta, so a tool missing from it shows
  // as plain work, and a money tool missing from it would never be typed as one. An app
  // gives no lookups while unconfigured; mcp.test.ts checks every one with keys set.
  it("say what they do in a line short enough for their tile, and how to try what the owner acts through", () => {
    for (const app of apps()) {
      const { id, does, starts } = app.about;
      expect(does, `${id} says what it does`).toMatch(/^\S.{2,39}(?<![.!])$/u);
      // A way to try it starts a chat, which only helps where Claude then has something of it.
      if (starts) expect(hasSwitch(app), `${id} offers ways to try it`).toBe(true);
      for (const { title, prompt } of starts ?? []) {
        expect(title.length, `${id}: "${title}" fits a chip`).toBeLessThanOrEqual(32);
        expect(prompt.length, `${id}: "${title}" says what to ask`).toBeGreaterThan(title.length);
      }
    }
  });

  it("register exactly the money tools their meta lists, and no lookup it doesn't", () => {
    for (const { about, moves, lookups } of apps()) {
      const recipes = (moves ?? []).map((recipe) => recipe.tool).toSorted();
      expect({ id: about.id, money: recipes }).toEqual({
        id: about.id,
        // Its moves are its money tools, and the moves a card of its allows for later.
        money: [
          ...toolsOfKind(about.tools, "money"),
          ...toolsOfKind(about.tools, "later"),
        ].toSorted(),
      });
      const reads = toolsOfKind(about.tools, "read");
      for (const tool of lookups?.() ?? []) expect(reads).toContain(tool.name);
    }
  });

  // The watch tool carries each source's guide and its condition as JSON Schema, and a watch
  // with no key always has somewhere to go.
  it("watch through sources the agent can be told how to write for, one needing no key", () => {
    for (const { about, source } of sources()) {
      expect(source.guide.length, about.id).toBeGreaterThan(100);
      expect(() => z.toJSONSchema(source.condition, { unrepresentable: "any" })).not.toThrow();
    }
    expect(sources().some(({ source }) => source.configured())).toBe(true);
  });

  // A new chat's starting points come from these, and a fresh install sees something with no key.
  it("say what they see through a function core calls, one with no key", () => {
    for (const { about, facts } of factSources()) expect(facts, about.id).toBeTypeOf("function");
    expect(factSources().map(({ about }) => about.id)).toEqual(
      expect.arrayContaining(["polymarket", "prices"]),
    );
  });

  it("give core what it asks of a venue, filing every recipe under its app", () => {
    for (const app of apps()) expectKindsKept(app);
    expect(firstBridge().bridge.recipe.tool).toBe("bridge_usdc");
  });

  // Core prices and names a holding through the account that owns it, before any feed. An
  // account that owned what isn't its own would take over a coin, a dollar or another app's token.
  it("own no chain's coin, no dollar token and nothing another account owns", () => {
    expectOwnOnlyTheirOwn(apps());
    // Each kind of account is among the real ones, so the rule is held of each.
    const kinds = accounts().map(({ account: { kept } }) => Object.keys(kept).sort().join());
    expect(new Set(kinds)).toEqual(new Set(["wallet", "ledger", "chains,owns,read"]));
  });

  it("own every position their holdings read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              token_id: "123456789",
              current_size: 4,
              current_value: 2.4,
              title: "Will it rain?",
              outcome: "Yes",
              avg_price: 0.5,
            },
          ],
          pagination: { next_cursor: null },
        }),
      ),
    );
    try {
      const owner = `0x${"1".repeat(40)}` as const;
      let positions = 0;
      for (const { about, account } of accounts()) {
        const { kept } = account;
        const held =
          "wallet" in kept
            ? []
            : "ledger" in kept
              ? await kept.ledger(owner)
              : (await Promise.all(kept.chains.map((chain) => kept.read(owner, chain)))).flat();
        for (const holding of held) {
          if (holding.cash) continue;
          positions += 1;
          expect(accountOwning(holding)?.about.id, `${about.id} ${fillIdentity(holding)}`).toBe(
            about.id,
          );
        }
      }
      expect(positions).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("declare settings under names of their own, a secret's starting with its app's id", () => {
    const declared = apps().flatMap(({ about }) =>
      Object.values(about.settings ?? {}).map((setting) => ({ about, ...setting })),
    );
    expect(declared.map(({ env }) => env)).toContain("ELFA_AUTO_API_KEY");
    for (const { about, env: name, kind } of declared) {
      expect(name, about.id).toMatch(/^[A-Z][A-Z0-9_]*$/u);
      // What the web app may write is only ever an app's own: never a setting core reads.
      if (kind === "secret") expect(ownedBy(about, name), `${about.id}'s ${name}`).toBe(true);
      expect(Object.keys(env), `${name} is core's`).not.toContain(name);
    }
    const names = declared.map(({ env }) => env);
    expect(new Set(names).size).toBe(names.length);
  });

  // A send to a ledger has no chain receipt, so reconcile answers "confirmed" for one. If a
  // network could ever be found as a ledger, a reverted send on it would be recorded as done.
  it("never have a ledger that a network, the wallet or Auni itself could be taken for", () => {
    for (const place of [...NETWORK_KEYS, "wallet", "auni"]) {
      expect(ledgerAt(place), place).toBeUndefined();
      expect(
        apps().map(({ about }) => about.id),
        place,
      ).not.toContain(place);
    }
    // An account kept in the wallet or on chains is not a ledger, whatever its app's id.
    for (const { about, account } of accounts())
      expect(ledgerAt(about.id) !== undefined, about.id).toBe("ledger" in account.kept);
  });

  // The owner turns off only what they act through. What core's own work runs on (the wallet,
  // a brain, a bridge, a route) has no switch, so nothing core depends on can be switched away.
  // A new app's folder joins whichever side it belongs on, with no line here to change.
  it("have a switch only where the owner acts through one and core runs on none of it", () => {
    const switched = apps()
      .filter(hasSwitch)
      .map(({ about }) => about.id);
    expect(switched).toEqual(
      expect.arrayContaining(["aave", "elfa", "hyperliquid", "polymarket", "telegram"]),
    );
    for (const app of apps())
      if (app.swaps || app.solana || app.bridge || app.tokens || app.wallet || app.brain)
        expect(switched, app.about.id).not.toContain(app.about.id);
    expect(switched).not.toEqual(
      expect.arrayContaining(["across", "kyberswap", "local-key", "defillama"]),
    );
  });

  it("are all offered until the owner turns one off, and one with no switch always is", () => {
    const ids = (from: ReturnType<typeof apps>) => from.map(({ about }) => about.id);
    expect(ids(offered())).toEqual(ids(apps()));
    process.env.APPS_OFF = "polymarket,local-key,across,claude-code,kuru";
    try {
      expect(ids(offered())).toEqual(ids(apps()).filter((id) => id !== "polymarket"));
      // What it holds is still its own, and its move still has a recipe to run and be read by.
      expect(ids(apps())).toContain("polymarket");
      expect(appRecipes().map(({ tool }) => tool)).toContain("polymarket_order");
      expect(appRecipes(offered()).map(({ tool }) => tool)).not.toContain("polymarket_order");
      expect(factSources().map(({ about }) => about.id)).not.toContain("polymarket");
    } finally {
      delete process.env.APPS_OFF;
    }
  });

  it("name each job of their own after themselves, and keep no table under a name taken", async () => {
    for (const { about, jobs } of apps())
      for (const job of jobs ?? []) expect(job.kind.name, about.id).toMatch(`${about.id}:`);
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = [
      "../db/schema.ts",
      ...readdirSync(here)
        .filter((id) => existsSync(join(here, id, "tables.ts")))
        .map((id) => `./${id}/tables.ts`),
    ];
    const names = (
      await Promise.all(sources.map(async (source) => Object.values(await import(source))))
    )
      .flat()
      .filter((value): value is PgTable => is(value, PgTable))
      .map(getTableName);
    expect(names).toContain("signed_txs");
    expect(new Set(names).size).toBe(names.length);
  });

  // Where the first answer wins, who is asked first is a decision written in order.ts, not a
  // folder's place in the alphabet: a new feed can't take over prices by its name.
  it("are asked in the order order.ts gives, which lists exactly the apps that fill each role", () => {
    for (const role of Object.keys(ASKED_FIRST) as (keyof typeof ASKED_FIRST)[]) {
      expect(ASKED_FIRST[role].length, role).toBeGreaterThan(0);
      expect(
        filling(role).map(({ about }) => about.id),
        role,
      ).toEqual(ASKED_FIRST[role]);
      expect(
        apps()
          .flatMap((app) => (app[role] ? [app.about.id] : []))
          .toSorted(),
        role,
      ).toEqual(ASKED_FIRST[role].toSorted());
    }
    expect(firstBridge().about.id).toBe(ASKED_FIRST.bridge[0]);
  });

  it("hold wallets by default in exactly one app", () => {
    const defaults = apps().filter(({ wallet }) => wallet?.byDefault);
    expect(defaults).toHaveLength(1);
    expect(theWallet()).toBe(defaults[0]!.wallet);
  });

  describe("with WALLET set", () => {
    afterEach(() => {
      env.WALLET = undefined;
    });

    it("hold wallets in the app it names", () => {
      for (const { about, wallet } of apps().filter(({ wallet }) => wallet)) {
        env.WALLET = about.id;
        expect(theWallet()).toBe(wallet);
      }
    });

    it("refuse one no app holds wallets under", () => {
      env.WALLET = "nobody";
      expect(theWallet).toThrow(/named nobody/u);
    });
  });
});

describe("core", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  /** Core's own code: every file but the apps', the tests and the demo, which stands in for the apps' services and so names them. */
  const core = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !file.startsWith("apps/") &&
      !file.startsWith("test/") &&
      !file.startsWith("demo/"),
  );

  it("names no app its money runs through or is read by: it asks the registry for a role, and the web reads what an app says", () => {
    expect(apps().filter(coreAsks).length).toBeGreaterThan(12);
    const webRoot = fileURLToPath(new URL("../../../web/", import.meta.url));
    const web = ["app", "components", "lib"].flatMap((folder) =>
      readdirSync(join(webRoot, folder), { recursive: true, encoding: "utf8" })
        .map((file) => `../../web/${folder}/${file}`)
        .filter((file) => /\.tsx?$/u.test(file) && !/\.(test|generated)\.tsx?$/u.test(file)),
    );
    // Core's own skills, which Claude reads whatever apps are on: an app's tool is named there
    // only through a {{KEY}} the registry fills (see agent/skills.ts).
    const skills = readdirSync(join(root, "../skills"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".md"))
      .map((file) => `../skills/${file}`);
    const tools = apps()
      .filter(coreAsks)
      .flatMap(({ about }) => Object.keys(about.tools ?? {}));
    const files = [...core, ...web, ...skills];
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const named = apps()
      .filter(coreAsks)
      .flatMap(({ about }) => [
        { word: about.name, pattern: new RegExp(`(?<![\\w.])${escape(about.name)}(?![\\w])`, "u") },
        { word: `"${about.id}`, pattern: new RegExp(`"${escape(about.id)}`, "u") },
        { word: `${about.id}_`, pattern: new RegExp(`\\b${escape(about.id)}_`, "u") },
      ]);
    const found = files.flatMap((file) => {
      const text = readFileSync(join(root, file), "utf8");
      return [
        ...named.flatMap(({ word, pattern }) => (pattern.test(text) ? [`${file}: ${word}`] : [])),
        ...(file.startsWith("../skills/")
          ? tools.filter((tool) => new RegExp(`\\b${tool}\\b`, "u").test(text))
          : []
        ).map((tool) => `${file}: ${tool}`),
      ];
    });
    expect(found).toEqual([]);
  });

  it("calls the one person Auni answers to the owner, never the user, in anything Claude or a reader sees", () => {
    const written = [
      ...readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
        (file) =>
          /\.(ts|md)$/u.test(file) && !file.includes(".test.") && !file.includes("fixtures/"),
      ),
      ...readdirSync(join(root, "../skills"), { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".md"))
        .map((file) => `../skills/${file}`),
    ];
    // Across a line break too, with a comment's marks between the words.
    const said = /\bthe(?:\s|\/\/|\*|["'`+])*users?\b/iu;
    expect(written.filter((file) => said.test(readFileSync(join(root, file), "utf8")))).toEqual([]);
  });

  // An outside service is an app: its address is in its folder, with an owner in CODEOWNERS.
  // What is left in core is listed here, each with why it is core's own.
  it("holds no outside service's address but the few that are its own", () => {
    const OWN: Readonly<Record<string, readonly string[]>> = {
      // The owner's own Alchemy key, when they set one: an RPC, which core reads chains through.
      "money/chains.ts": ["https://${network}.g.alchemy.com/v2"],
      // A site's icon: for an app the agent names on a card nothing vouches for, and for each
      // site the work reads (routes/site-marks.ts), by the addresses Google may know it by.
      "money/app-logo.ts": [
        "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=${size}&url=${address}",
        "https://${host}",
      ],
      "routes/site-marks.ts": ["https://${host}"],
      // Two that read an address and dial nothing: a site's host, and whether a logo is https.
      "money/raw-transaction.ts": ["https://${site}"],
      "money/token-feeds.ts": ["https://"],
      // The owner's own machine on their tailnet, the address their devices open.
      "always-on.ts": ["https://${name}${port"],
      // The box's by-hand test has the agent read one public page.
      "agent/escape.ts": ["https://example.com/"],
      // Auni's own installer, which a machine Auni moves to runs first.
      "handover/hand-over.ts": [
        "https://raw.githubusercontent.com/jarrodwatts/auni/main/install.sh",
      ],
    };
    const held = Object.fromEntries(
      core.flatMap((file) => {
        const found = readFileSync(join(root, file), "utf8").match(/https:\/\/[^\s"'`)]*/gu);
        return found ? [[file, found]] : [];
      }),
    );
    expect(held).toEqual(OWN);
  });

  // The registry loads every app, so an app whose own imports led back to it would load
  // in a loop, half-built. Core files an app calls that need the registry reach it with
  // `await import()` when called (money/wallets.ts does).
  it("is never loaded by loading an app", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    /** The files `file` loads as it loads: its value imports and re-exports, not types or import(). */
    const loads = (file: string): string[] => {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
      return source.statements.flatMap((statement) => {
        let types = false;
        let from: ts.Expression | undefined;
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          const named = clause?.namedBindings;
          types = Boolean(
            clause &&
            (clause.isTypeOnly ||
              (!clause.name &&
                named &&
                ts.isNamedImports(named) &&
                named.elements.length > 0 &&
                named.elements.every((element) => element.isTypeOnly))),
          );
          from = statement.moduleSpecifier;
        } else if (ts.isExportDeclaration(statement)) {
          types = statement.isTypeOnly;
          from = statement.moduleSpecifier;
        }
        if (types || !from || !ts.isStringLiteral(from) || !from.text.startsWith(".")) return [];
        return [join(dirname(file), from.text)];
      });
    };
    const forbidden = new Set([
      join(src, "apps/registry.ts"),
      join(src, "apps/index.generated.ts"),
    ]);
    const reached = apps().flatMap(({ about }) => {
      const start = join(src, "apps", about.id, "index.ts");
      const via = new Map<string, string | null>([[start, null]]);
      for (const file of via.keys()) {
        if (forbidden.has(file)) {
          const path: string[] = [];
          for (let at: string | null = file; at; at = via.get(at) ?? null)
            path.unshift(relative(src, at));
          return [path.join(" -> ")];
        }
        for (const next of loads(file)) if (!via.has(next)) via.set(next, file);
      }
      return [];
    });
    expect(reached).toEqual([]);
  });
});
