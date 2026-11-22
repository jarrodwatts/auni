import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { theBox } from "./box.ts";
import {
  parseRoutine,
  readRoutines,
  routineBodySchema,
  routineNameSchema,
  routinesDir,
  writeRoutine,
} from "./routines.ts";
import { saveRoutineTool } from "./routine-tool.ts";
import { loadSkillTool } from "./skills.ts";
import type { ToolTurn } from "./tool.ts";

beforeEach(() => rmSync(routinesDir(), { recursive: true, force: true }));

const routine = {
  name: "check-rates",
  description: "Load when moving idle cash: how I compare savings markets.",
  body: "1. Read each Aave market's rate.\n2. Move only for more than {{HALF_A_POINT}}.",
};

describe("a routine's name", () => {
  it("is Agent Skills' kind of name, and never one of Auni's own skills", async () => {
    for (const bad of ["Check rates", "check_rates", "-check", "check--rates", "a".repeat(65)])
      expect(routineNameSchema.safeParse(bad).success).toBe(false);
    expect(routineNameSchema.safeParse("check-rates-2").success).toBe(true);
    const tool = saveRoutineTool({} as ToolTurn);
    const refused = await tool.handler({ ...routine, name: "how-auni-works" });
    expect(refused).toMatchObject({ isError: true });
  });

  it("keeps a body to what a card can show", () => {
    expect(routineBodySchema.safeParse("x".repeat(4_001)).success).toBe(false);
  });
});

describe("writeRoutine", () => {
  it("writes a skill file the owner alone can read, in a folder only they can open", () => {
    writeRoutine(routine);
    const path = join(routinesDir(), "check-rates", "SKILL.md");
    expect(readFileSync(path, "utf8")).toBe(
      '---\nname: check-rates\ndescription: "Load when moving idle cash: how I compare savings markets."\n---\n\n' +
        `${routine.body}\n`,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(routinesDir(), "check-rates")).mode & 0o777).toBe(0o700);
    expect(parseRoutine("check-rates", readFileSync(path, "utf8"))).toEqual(routine);
  });

  it("replaces one of the same name whole", () => {
    writeRoutine(routine);
    writeRoutine({ ...routine, body: "Just ask me." });
    expect(readRoutines()).toEqual([{ ...routine, body: "Just ask me." }]);
  });
});

describe("readRoutines", () => {
  it("skips a file that isn't a routine, and says so", () => {
    writeRoutine(routine);
    for (const [folder, text] of [
      ["no-frontmatter", "Just words."],
      ["wrong-name", "---\nname: other\ndescription: x\n---\n\nbody"],
      ["no-body", "---\nname: no-body\ndescription: x\n---\n"],
    ]) {
      mkdirSync(join(routinesDir(), folder!), { recursive: true });
      writeFileSync(join(routinesDir(), folder!, "SKILL.md"), text!);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readRoutines().map(({ name }) => name)).toEqual(["check-rates"]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("reads a routine the owner wrote by hand, with a plain description", () => {
    mkdirSync(join(routinesDir(), "weekly-review"), { recursive: true });
    writeFileSync(
      join(routinesDir(), "weekly-review", "SKILL.md"),
      "---\nname: weekly-review\ndescription: Load on Sundays.\n---\n\nLook back at the week.\n",
    );
    expect(readRoutines()).toEqual([
      { name: "weekly-review", description: "Load on Sundays.", body: "Look back at the week." },
    ]);
  });
});

describe("load_skill", () => {
  it("lists the owner's routines beside Auni's skills, and returns one as saved, unfilled", async () => {
    writeRoutine(routine);
    const tool = loadSkillTool();
    expect(tool.description).toContain(
      "- check-rates (the owner's routine): Load when moving idle cash",
    );
    expect(tool.description).toContain("- how-auni-works: Load ");
    const { content } = await tool.handler({ name: "check-rates" });
    const text = content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("The owner's routine");
    expect(text).toContain("{{HALF_A_POINT}}");
  });

  it("sees a routine the moment it's saved or deleted", () => {
    const names = () => z.object(loadSkillTool().inputSchema).safeParse({ name: "check-rates" });
    expect(names().success).toBe(false);
    writeRoutine(routine);
    expect(names().success).toBe(true);
    rmSync(join(routinesDir(), "check-rates"), { recursive: true });
    expect(names().success).toBe(false);
  });
});

describe("the agent's box", () => {
  it("hides the routines, so only the owner's tap writes one", () => {
    const { hidden, readable } = theBox([]);
    const inside = (dirs: readonly string[]) =>
      dirs.some((dir) => routinesDir() === dir || routinesDir().startsWith(`${dir}/`));
    expect(inside(hidden)).toBe(true);
    expect(inside(readable)).toBe(false);
  });
});
