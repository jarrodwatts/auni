import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChartChange } from "./chart-change";

/** What a reader hears: the figure once (its rolling digits are hidden), then what it measures. */
function said(change: bigint, label: string): string {
  const html = renderToStaticMarkup(<ChartChange move={{ change, percent: 0.5 }} label={label} />);
  const figure = /class="sr-only">([^<]*)</.exec(html)?.[1];
  const words = /<span class="[^"]*truncate[^"]*">([^]*?)<\/span>/.exec(html)?.[1];
  return `${figure} ${words?.replace(/<!-- -->/g, "")}`;
}

describe("ChartChange", () => {
  it("names a gain as what the holdings made, not as the account's move", () => {
    expect(said(88_630_000n, "in the past week")).toBe("+$88.63 (0.5%) made in the past week");
  });

  it("names a loss as lost", () => {
    expect(said(-940_000n, "today")).toBe("−$0.94 (0.5%) lost today");
  });

  it("says a move under a cent made nothing", () => {
    expect(said(4_000n, "since Oct 21")).toBe("$0 (0.5%) made since Oct 21");
  });
});
