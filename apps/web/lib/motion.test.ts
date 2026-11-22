import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { blurs, durations, easings, reducedMotion } from "./motion";

const tokens = readFileSync(new URL("../app/tokens.css", import.meta.url), "utf8");

/** The value CSS gives a custom property, or undefined when it has none. */
function cssToken(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`, "u").exec(tokens)?.[1]?.trim();
}

describe("motion tokens", () => {
  it("gives CSS the same curves as the Web Animations API", () => {
    for (const [name, value] of Object.entries(easings)) {
      expect(cssToken(`motion-${name}`), name).toBe(value);
    }
  });

  it("gives CSS the same durations", () => {
    for (const [name, value] of Object.entries(durations)) {
      expect(cssToken(`motion-duration-${name}`), name).toBe(`${value}ms`);
    }
  });

  it("gives CSS the same blurs", () => {
    for (const [name, value] of Object.entries(blurs)) {
      expect(cssToken(`motion-blur-${name}`), name).toBe(`${value}px`);
    }
  });
});

describe("reducedMotion", () => {
  it("is off on the server, where there is no one to ask", () => {
    expect(reducedMotion()).toBe(false);
  });
});
