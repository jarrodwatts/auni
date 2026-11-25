import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { expectKindsKept } from "../test/venue-rules.ts";
import type { App } from "./contract.ts";
import { hasSwitch } from "./registry.ts";
import { guidesFor, PARTS, scaffold, type Part } from "./scaffold.ts";
import { designTokens, themeProblem } from "./theme.ts";

// Each shape is written beside the real apps, since its imports are relative, under an id no one
// would take, and is gone afterwards. `pnpm gen` never sees it, so core's list is untouched.
const PREFIX = "scaffold-test-";
/** Every part alone, know-how alone (no parts), and a vault: money in, and an account. */
const SHAPES: Readonly<Record<string, readonly Part[]>> = {
  ...Object.fromEntries(PARTS.map((part) => [part, [part]])),
  "know-how": [],
  vault: ["moves", "account"],
};
const folderOf = (shape: string) => path.join(import.meta.dirname, `${PREFIX}${shape}`);
const clear = () =>
  Promise.all(
    Object.keys(SHAPES).map((shape) => rm(folderOf(shape), { recursive: true, force: true })),
  );

beforeAll(async () => {
  await clear();
  for (const [shape, parts] of Object.entries(SHAPES))
    await scaffold(`${PREFIX}${shape}`, parts, import.meta.dirname);
});
afterAll(clear);

const load = async (shape: string) =>
  ((await import(path.join(folderOf(shape), "index.ts"))) as { default: App }).default;

const toolsOfKind = (app: App, kind: string) =>
  Object.entries(app.about.tools ?? {}).flatMap(([name, tool]) =>
    tool.kind === kind ? [name] : [],
  );

describe("pnpm scaffold", () => {
  it.each(Object.keys(SHAPES))("writes a %s app that keeps every app rule", async (shape) => {
    const app = await load(shape);
    expect(app.about.id).toBe(`${PREFIX}${shape}`);
    for (const part of SHAPES[shape]!) expect(app[part], part).toBeDefined();
    expectKindsKept(app);
    expect((app.moves ?? []).map((recipe) => recipe.tool)).toEqual(toolsOfKind(app, "money"));
    // An app with a money tool starts with one refusal to word, and its recorded answer.
    expect(app.problems?.known.length ?? 0).toBe(app.moves ? 1 : 0);
    for (const { example } of app.problems?.known ?? [])
      expect(existsSync(path.join(folderOf(shape), example)), example).toBe(true);
    expect((app.lookups?.() ?? []).map((tool) => tool.name)).toEqual(toolsOfKind(app, "read"));
    // Claude learns any app it works with from its skill, which names every tool it has.
    const skill = path.join(folderOf(shape), "SKILL.md");
    const taught = Boolean(app.moves || app.reads || app.lookups);
    expect(existsSync(skill)).toBe(taught || SHAPES[shape]!.length === 0);
    if (existsSync(skill)) {
      const text = readFileSync(skill, "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${app.about.id}\\ndescription: `, "u"));
      for (const tool of Object.keys(app.about.tools ?? {})) expect(text).toContain(tool);
      // Its words for Claude are marked unwritten, which apps.test.ts fails until they are.
      expect(text).toMatch(/^description: .*\bTODO\b/mu);
      expect(hasSwitch(app)).toBe(true);
    }
    // A new feed prices nothing, so it changes no price by being added.
    expect((await app.tokens?.prices?.(["coingecko:solana"]))?.size ?? 0).toBe(0);
    // A new wallet never takes over from the default one by being added.
    expect(app.wallet?.byDefault).toBeUndefined();
    // Nor does a new source or channel switch on, nor an account own what someone holds.
    expect(app.watches?.configured() ?? false).toBe(false);
    expect(app.channel?.configured() ?? false).toBe(false);
    if (app.watches) expect(app.watches.guide).toMatch(/\bTODO\b/u);
    if (app.account) expect(app.account.kept).toEqual({ wallet: [] });
  });

  // An AGENTS.md in an app's folder joins the chain a coding agent reads from the repo root down,
  // which agents-md.test.ts keeps within a budget the pages above an app nearly fill. So a new app
  // adds none, and the scaffold names the pages to read.
  it("adds no AGENTS.md, and names the guides to read", () => {
    for (const shape of Object.keys(SHAPES))
      expect(existsSync(path.join(folderOf(shape), "AGENTS.md")), shape).toBe(false);
    expect(guidesFor([])).toEqual(["AGENTS.md"]);
    expect(guidesFor(["account", "lookups"])).toEqual(["AGENTS.md", "venue.md", "tools.md"]);
    for (const guide of guidesFor(PARTS))
      expect(existsSync(path.join(import.meta.dirname, guide)), guide).toBe(true);
  });

  it("writes a look alone as a theme `pnpm gen` takes, with nothing for Claude to learn", async () => {
    const id = `${PREFIX}look`;
    const folder = path.join(import.meta.dirname, id);
    await rm(folder, { recursive: true, force: true });
    try {
      await scaffold(id, [], import.meta.dirname, { theme: true });
      const tokens = designTokens(
        readFileSync(path.join(import.meta.dirname, "../../../web/app/tokens.css"), "utf8"),
      );
      const css = readFileSync(path.join(folder, "theme.css"), "utf8");
      expect(themeProblem(id, css, tokens)).toBeNull();
      expect(existsSync(path.join(folder, "SKILL.md"))).toBe(false);
      const app = ((await import(path.join(folder, "index.ts"))) as { default: App }).default;
      expect(app.guide).toBeUndefined();
      // A look is picked in Settings, so it has no switch among the apps.
      expect(hasSwitch(app)).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("gives an account the move money goes in by", async () => {
    const vault = await load("vault");
    expect(vault.account?.moneyIn).toBe(vault.moves?.[0]);
    expect((await load("account")).moves).toHaveLength(1);
  });

  // Run as its own vitest, as a contributor runs it, with none of this run's state, and without
  // colour, which a terminal (or CI) otherwise puts between the words the summary is read by.
  it("writes apps whose own tests pass", () => {
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("VITEST") && name !== "FORCE_COLOR",
        ),
      ),
      NO_COLOR: "1",
    };
    const out = execFileSync("pnpm", ["exec", "vitest", "run", `src/apps/${PREFIX}`], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env,
      encoding: "utf8",
    });
    // Every shape but know-how alone has a test of its own.
    const tested = Object.values(SHAPES).filter((parts) => parts.length).length;
    expect(out).toMatch(new RegExp(`Test Files\\s+\\d+ passed`, "u"));
    expect(Number(/Test Files\s+(\d+) passed/u.exec(out)?.[1])).toBeGreaterThanOrEqual(tested);
  }, 120_000);

  it("refuses an id that isn't a folder name, one core uses, and a folder that's taken", async () => {
    const appsDir = tempDir("auni-scaffold-");
    await expect(scaffold("My_Dex", [], appsDir)).rejects.toThrow(/isn't an app id/u);
    for (const taken of ["base", "wallet", "auni", "demo", "evm", "xstocks", "solana-swap"])
      await expect(scaffold(taken, [], appsDir)).rejects.toThrow(/already uses/u);
    await scaffold("my-dex", ["moves"], appsDir);
    await expect(scaffold("my-dex", [], appsDir)).rejects.toThrow(/already exists/u);
  });
});
