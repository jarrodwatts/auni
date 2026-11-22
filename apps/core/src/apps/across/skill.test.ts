import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { problems } from "./problems.ts";

const skill = readFileSync(new URL("SKILL.md", import.meta.url), "utf8");

describe("Across's skill", () => {
  it("says the next move for each refusal the app knows, and for a deposit Auni refuses", () => {
    const refusals = skill.split("## When it refuses")[1]!.split("\n## ")[0]!;
    const sentences = new Set(problems.known.map(({ say }) => say));
    expect(refusals.match(/^- \*\*/gmu)).toHaveLength(sentences.size + 1);
  });
});
