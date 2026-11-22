import path from "node:path";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// An app's own card is built into the web app, so what it may import is held by ESLint
// (eslint.config.mjs, auni/import-paths). These lint a card and a schema as if they sat in an
// app's folder.

const ROOT = path.resolve(import.meta.dirname, "../../../..");
// Without type information, which only rules other than the import rules need, and which would
// take a minute to load for one file.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: {
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
});

/** The import paths ESLint refuses in `source`, as a file at `file` in an app's folder. */
async function refused(file: string, source: string): Promise<string[]> {
  const [report] = await eslint.lintText(source, {
    filePath: path.join(ROOT, "apps/core/src/apps/elfa", file),
  });
  return report!.messages
    .filter((message) => message.ruleId === "auni/import-paths")
    .map((message) => /'([^']+)'/u.exec(message.message)?.[1] ?? message.message);
}

const imports = (paths: readonly string[]) =>
  paths.map((from, index) => `import * as m${index} from "${from}";\nvoid m${index};`).join("\n");
/** The same paths, each loaded with import() and re-exported, the two forms an import rule may miss. */
const loads = (paths: readonly string[]) =>
  paths
    .map((from, index) => `export const l${index} = import("${from}");\nexport * from "${from}";`)
    .join("\n");

describe("an app's own card", () => {
  // Loading the config and its plugins is most of the time; it is done once, before any test.
  beforeAll(() => refused("fixture.card.tsx", ""), 120_000);

  it("draws with react, @auni/shared, the web's components and helpers, and its folder's views and schemas", async () => {
    const allowed = [
      "react",
      "@auni/shared",
      "@/components/cards/auni-note",
      "@/lib/utils",
      "@/lib/money",
      "./parts.tsx",
      "./tape.schema.ts",
    ];
    expect(await refused("fixture.card.tsx", imports(allowed))).toEqual([]);
  });

  it("can't reach the web's data or core, its app's other code, or anything else", async () => {
    const barred = [
      "@/lib/data/actions",
      "@/lib/core",
      "./request.ts",
      "../../env.ts",
      "../contract.ts",
      "../telegram/tape.card.tsx",
      "node:fs",
      "zod",
    ];
    expect(await refused("fixture.card.tsx", imports(barred))).toEqual(barred);
    expect(await refused("fixture.card.tsx", loads(barred))).toEqual(
      barred.flatMap((from) => [from, from]),
    );
  });

  it("can't load what its path is computed from, which no rule could read", async () => {
    const source = 'const name = "./request.ts";\nexport const leaked = import(name);';
    expect(await refused("fixture.card.tsx", source)).toHaveLength(1);
  });

  it("is handed data whose schema imports zod and @auni/shared only", async () => {
    expect(await refused("fixture.schema.ts", imports(["zod", "@auni/shared"]))).toEqual([]);
    expect(await refused("fixture.schema.ts", imports(["./request.ts", "../../env.ts"]))).toEqual([
      "./request.ts",
      "../../env.ts",
    ]);
    expect(await refused("fixture.schema.ts", loads(["./request.ts"]))).toEqual([
      "./request.ts",
      "./request.ts",
    ]);
  });
});
