import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { listed } from "@auni/shared";
import { z } from "zod";

import type { App } from "../apps/contract.ts";
import { apps, firstBridge, offered } from "../apps/registry.ts";
import { recognisedHow } from "../money/recognised.ts";
import { networkFacts } from "./prompt.ts";
import { readRoutines } from "./routines.ts";
import { defineTool, result } from "./tool.ts";

const SKILLS_ROOT = fileURLToPath(new URL("../../skills", import.meta.url));
const APPS_ROOT = fileURLToPath(new URL("../apps", import.meta.url));

/**
 * A skill's text with its {{KEY}}s filled in from `values`, so what it says of the code is read
 * from the code; one with no value fails as the skills are read, not in front of the agent.
 */
export function fillSkill(
  text: string,
  values: Readonly<Record<string, string>>,
  path = "a skill",
): string {
  return text.replaceAll(/\{\{(\w+)\}\}/gu, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${path} names {{${key}}}, which has no value.`);
    return value;
  });
}

interface Skill {
  readonly name: string;
  readonly description: string;
  /** The SKILL.md as written, its {{KEY}}s still to fill. */
  readonly text: string;
  readonly path: string;
}

/** The SKILL.md at `path`, which must be named `name` and say when to load it. */
function readSkill(path: string, name: string): Skill {
  const text = readFileSync(path, "utf8");
  const field = (key: string) => new RegExp(`^${key}: (.+)$`, "mu").exec(text)?.[1]?.trim();
  const description = field("description");
  if (field("name") !== name || !description)
    throw new Error(`${path} needs the name ${name} and a description.`);
  return { name, description, text, path };
}

let skills: readonly Skill[] | undefined;

/** Auni's own skills, each skills/<name>/SKILL.md, read once: they ship with the code. */
function builtIn(): readonly Skill[] {
  skills ??= readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkill(join(SKILLS_ROOT, entry.name, "SKILL.md"), entry.name));
  return skills;
}

const ofApps = new Map<string, Skill | null>();

/**
 * An app's own skill, the SKILL.md in its folder, named by its id; null when it has none.
 * Read once: it ships with the code.
 */
function appSkill({ about }: App): Skill | null {
  if (!ofApps.has(about.id)) {
    const path = join(APPS_ROOT, about.id, "SKILL.md");
    ofApps.set(about.id, existsSync(path) ? readSkill(path, about.id) : null);
  }
  return ofApps.get(about.id)!;
}

/** The skills of the apps the owner has on, each with its app. */
function offeredSkills(): readonly { readonly app: App; readonly skill: Skill }[] {
  return offered().flatMap((app) => {
    const skill = appSkill(app);
    return skill ? [{ app, skill }] : [];
  });
}

/** Whether a name is one of Auni's own skills or an app's, which no routine may take. */
export function isBuiltInSkill(name: string): boolean {
  return (
    builtIn().some((skill) => skill.name === name) ||
    apps().some((app) => appSkill(app)?.name === name)
  );
}

/**
 * What picking-a-venue's {{APPS}} says: a line for each app that is on and has a skill, with
 * its name, when to load its skill, and the tools it gives the agent.
 */
function appLines(): string {
  const lines = offeredSkills().map(({ app: { about }, skill }) => {
    const tools = Object.entries(about.tools ?? {})
      .filter(([, tool]) => tool.kind !== "recorded")
      .map(([name]) => `\`${name}\``);
    const its = tools.length ? ` Its tools: ${tools.join(", ")}.` : "";
    return `- **${about.name}** (the ${skill.name} skill): ${skill.description}${its}`;
  });
  return lines.join("\n") || "None is on.";
}

/**
 * What Auni's own skills say of the apps, filled from the registry, so a skill names no app
 * (apps.test.ts holds it to that) and never speaks of one the owner has switched off.
 */
function appFacts(): Readonly<Record<string, string>> {
  const on = offered();
  /** "the dexscreener skill and the defillama skill": the skills of the apps on that `fill`. */
  const skillsOf = (fill: (app: App) => unknown, none: string) =>
    listed(
      on.flatMap((app) => {
        const skill = fill(app) ? appSkill(app) : null;
        return skill ? [`the ${skill.name} skill`] : [];
      }),
      "and",
    ) || none;
  return {
    APPS: appLines(),
    /** The bridge's money tool, which moves cash between chains. */
    BRIDGE: firstBridge().bridge.recipe.tool,
    /** Where cash may sit beyond the wallet: each app that is on and keeps some. */
    CASH_APPS:
      listed(
        on.flatMap(({ about, account }) => (account?.cash ? [about.name] : [])),
        "and",
      ) || "no app that keeps cash is on",
    RECOGNISED: recognisedHow(),
    TOKEN_SKILLS: skillsOf(
      (app) => app.tokens,
      "no app that finds or prices tokens is on, so search with fetch_url",
    ),
    SOLANA_TOKEN_SKILLS: skillsOf(
      (app) => app.solana,
      "no app that lists Solana tokens is on, so treat every token as unverified",
    ),
  };
}

/**
 * Auni's playbooks and the owner's routines, as one tool every brain reaches the same way: its
 * description lists each and when to load it, and a call returns its text. A built-in skill is
 * filled from the code as it is; a routine is read fresh and returned as the owner saved it.
 */
export function loadSkillTool() {
  // An app's skill only while the owner has it on, as with its tools.
  const known = [...builtIn(), ...offeredSkills().map(({ skill }) => skill)];
  const routines = readRoutines().filter((routine) => !isBuiltInSkill(routine.name));
  const names = [...known, ...routines].map((skill) => skill.name) as [string, ...string[]];
  return defineTool({
    name: "load_skill",
    description:
      "Load one of Auni's skills, the playbooks for apps and transactions, or one of the " +
      "owner's routines, the ways of working they asked you to keep, before the work it " +
      "covers. Each, and when to load it:\n" +
      [
        ...known.map((skill) => `- ${skill.name}: ${skill.description}`),
        ...routines.map(
          (routine) => `- ${routine.name} (the owner's routine): ${routine.description}`,
        ),
      ].join("\n"),
    inputSchema: { name: z.enum(names) },
    async handler({ name }) {
      const routine = routines.find((each) => each.name === name);
      if (routine)
        return result(
          `The owner's routine "${routine.name}", saved with their tap; follow it:\n\n${routine.body}`,
        );
      const skill = known.find((each) => each.name === name)!;
      const values = { ...(await networkFacts()), ...appFacts() };
      return result(fillSkill(skill.text, values, skill.path));
    },
  });
}
