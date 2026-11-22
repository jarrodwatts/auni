import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { ROUTER, ROUTER_CHAINS } from "./reader.ts";

const skill = readFileSync(new URL("SKILL.md", import.meta.url), "utf8").replaceAll(/\s+/gu, " ");

// What the skill tells Claude of KyberSwap's router is what its reader vouches for.
describe("KyberSwap's skill", () => {
  it("names the router and the chains the reader knows it on, and no other", () => {
    const said = /Its router is `(0x[0-9a-fA-F]{40})` on (.+?)\. /u.exec(skill);
    expect(said?.[1]).toBe(ROUTER);
    expect(said?.[2]?.split(/, | and /u).toSorted()).toEqual(
      ROUTER_CHAINS.map((chain) => NETWORKS[chain].name).toSorted(),
    );
  });
});
