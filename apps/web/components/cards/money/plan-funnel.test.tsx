import type { ActionPlanCardWire } from "@auni/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Costs } from "./plan-funnel";

// Found in review: a plan said "Costs $2.70 price impact" where a lone card says "Price impact $0.25".
it("says each of a plan's costs by its own name, as a lone card does", () => {
  const html = renderToStaticMarkup(
    <Costs
      costs={[
        { label: "Network fee", value: "$0.30" },
        { label: "Price impact", value: "$2.70" },
      ]}
    />,
  );
  expect(html.replace(/<[^>]+>/gu, "")).toBe("Network fee $0.30Price impact $2.70");
  expect(renderToStaticMarkup(<Costs costs={undefined} />)).toBe("");
});

// Found in review: a plan saved before kept its costs as one sentence, read back unchecked from
// the chat's history, and drawing it as a list threw. That sentence is under another name.
it("draws no costs for a plan saved before, rather than failing to draw", () => {
  const saved = JSON.parse('{"costs":"$2.70 price impact"}') as Pick<
    ActionPlanCardWire,
    "costFigures"
  >;
  expect(renderToStaticMarkup(<Costs costs={saved.costFigures} />)).toBe("");
});
