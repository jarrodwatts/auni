import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { designTokens, themeProblem } from "./theme.ts";

const TOKENS = designTokens(
  readFileSync(new URL("../../../web/app/tokens.css", import.meta.url), "utf8"),
);
const look = (body: string, id = "night") => `:root[data-theme="${id}"] {\n${body}\n}\n`;

describe("an app's theme", () => {
  it("knows the web's design tokens, colours and type among them", () => {
    for (const token of ["--background", "--foreground", "--primary", "--color-ink", "--radius"])
      expect(TOKENS.has(token), token).toBe(true);
  });

  it("may give Auni's own tokens other values, under its own selector", () => {
    const css = `/* Night: a darker Auni. */\n${look('--background: #0f1218;\n  --color-ink: rgb(240 242 248 / 96%);\n  --font-sans: "Inter", sans-serif;')}`;
    expect(themeProblem("night", css, TOKENS)).toBeNull();
  });

  it.each([
    ["names another app's selector", look("--background: #000;", "day"), /names "day"/u],
    [
      "sets something that is no token",
      look("--my-own: #000;"),
      /isn't one of Auni's design tokens/u,
    ],
    ["sets a property", look("display: none;"), /isn't one of Auni's design tokens/u],
    [
      "fetches a picture",
      look("--background: url(https://evil.example/x.png);"),
      /nothing fetched/u,
    ],
    ["escapes its way to one", look("--background: u\\72l(x);"), /nothing fetched/u],
    ["adds a second rule", `${look("--background: #000;")}body { display: none }`, /one rule/u],
    [
      "imports a sheet",
      `@import "https://evil.example/a.css";\n${look("--background: #000;")}`,
      /one rule/u,
    ],
    ["styles something else", `.money-card { color: red }`, /one rule/u],
    ["nests a rule", look("--background: #000; & body { color: red }"), /one rule/u],
    ["sets nothing", look(""), /sets no token/u],
  ])("is refused when it %s", (_, css, why) => {
    expect(themeProblem("night", css, TOKENS)).toMatch(why);
  });
});
