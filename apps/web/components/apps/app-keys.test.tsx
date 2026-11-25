import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Linked } from "./app-keys";

// Polymarket's keys said where to get them, "your builder profile on polymarket.com", with no way
// there (2026-11-25).
it("links the site an app's help names", () => {
  const drawn = renderToStaticMarkup(
    <Linked text="From your builder profile on polymarket.com." />,
  );
  expect(drawn).toBe(
    'From your builder profile on <a href="https://polymarket.com" target="_blank" rel="noreferrer" class="font-medium text-ink underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60">polymarket.com</a>.',
  );
  expect(renderToStaticMarkup(<Linked text="Paste it here" />)).toBe("Paste it here");
});
