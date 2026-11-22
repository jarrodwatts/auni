import { readFileSync } from "node:fs";

import { NETWORKS, type EvmCashKey } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { AAVE } from "./aave.ts";
import { problems } from "./problems.ts";

const skill = readFileSync(new URL("SKILL.md", import.meta.url), "utf8");

// What the skill tells Claude of Aave is what the app holds its moves to.
describe("Aave's skill", () => {
  it("names the chains whose markets the moves use, and no other", () => {
    const names = Object.keys(AAVE).map((chain) => NETWORKS[chain as EvmCashKey].name);
    const said = /USDC market on one chain: (.+?)\./u.exec(skill.replaceAll(/\s+/gu, " "))?.[1];
    expect(said?.split(/, | or /u).toSorted()).toEqual(names.toSorted());
  });

  it("says the next move for each refusal the app knows", () => {
    const refusals = skill.split("## When it refuses")[1]!.split("\n## ")[0]!;
    expect(refusals.match(/^- \*\*/gmu)).toHaveLength(problems.known.length);
  });
});
