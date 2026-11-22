import { execFileSync } from "node:child_process";
import path from "node:path";

import { guidesFor, PARTS, scaffold, type Part } from "./scaffold.ts";

// `pnpm scaffold <id> [--with <parts>]`: writes a new app's folder (scaffold.ts), formats it, and
// runs `pnpm gen` so core and the web know it, leaving an app whose own tests pass.

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const [id, flag, list] = process.argv.slice(2);
const asked = (flag === "--with" ? (list ?? "") : "").split(",").filter(Boolean);
// A look is a file of its own (theme.css), which any app may bring beside its parts.
const theme = asked.includes("theme");
const parts = asked.filter((part) => part !== "theme");
const usage = `Usage: pnpm scaffold <id> [--with <${[...PARTS, "theme"].join(",")}>], e.g. pnpm scaffold my-vault --with moves,account. With no parts it is know-how alone: a SKILL.md; with theme alone, a look.`;

if (
  !id ||
  id.startsWith("-") ||
  (flag && flag !== "--with") ||
  !parts.every((part) => PARTS.includes(part as Part))
) {
  console.error(usage);
  process.exit(1);
}

try {
  const files = await scaffold(id, parts as Part[], import.meta.dirname, { theme });
  const run = (...args: string[]) => execFileSync("pnpm", args, { cwd: ROOT, stdio: "inherit" });
  run("exec", "prettier", "--log-level", "warn", "--write", ...files);
  run("gen");
  const folder = path.relative(ROOT, path.dirname(files[0]!));
  const guides = guidesFor(parts as Part[]).map((guide) => path.join(path.dirname(folder), guide));
  console.log(
    [
      `Wrote ${folder}/: ${files.map((file) => path.basename(file)).join(", ")}.`,
      `Read ${guides.join(", ")}, fill in every TODO, then run its tests:`,
      `  pnpm --filter @auni/core exec vitest run src/apps/${id}`,
      ...(theme ? [`Its look is ${folder}/theme.css: change its colours, then run pnpm gen.`] : []),
      // Who is asked first about a price, or thinks first, is decided by hand, never by a
      // folder being added.
      ...(["tokens", "brain"] as const)
        .filter((role) => parts.includes(role))
        .map(
          (role) => `Then add "${id}" to the end of ${role} in ${path.dirname(folder)}/order.ts.`,
        ),
    ].join("\n"),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
