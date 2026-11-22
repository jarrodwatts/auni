import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { expect, it } from "vitest";

import { everyRecipe } from "./recipes/index.ts";

// Every money tool, core's own and each app's as the registry lists them, is held to its card
// by a drill in a test file of its own (see test/held-to-card.ts), so an app added without one
// fails here before anyone can allow its first card. A drill is a call the file makes, read from
// its code: one in a comment or a string doesn't count.
const SRC = path.resolve(import.meta.dirname, "..");

/** The tools a test file's code drills: the first argument of each holdsToCard call in it. */
function drilledIn(file: string): string[] {
  const code = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const tools: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "holdsToCard" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      tools.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(code);
  return tools;
}

function drilledTools(): Set<string> {
  const tests = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".test.ts") && !file.includes("node_modules"),
  );
  return new Set(tests.flatMap((file) => drilledIn(path.join(SRC, file))));
}

it("drills every money tool Auni has, so each is proved held to its card", () => {
  const drilled = drilledTools();
  const undrilled = everyRecipe()
    .map((recipe) => recipe.tool)
    .filter((tool) => !drilled.has(tool));
  expect(undrilled, "give each a drill: holdsToCard in test/held-to-card.ts").toEqual([]);
});
