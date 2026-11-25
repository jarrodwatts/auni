import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Row } from "./row";

// A Row given onClick drew a clickable div: no keyboard, no focus ring, nothing a screen reader
// could press (2026-11-25 council). A row that presses is now the element it's given.
it("becomes the button or link it's given, with its parts inside and a focus ring", () => {
  const html = renderToStaticMarkup(
    <Row asChild title="Hyperliquid" meta="Perps" end="$12.40">
      <button type="button">
        <span>under</span>
      </button>
    </Row>,
  );
  expect(html).toMatch(/^<button type="button" data-slot="row" class="[^"]*focus-visible:ring/u);
  expect(html).toContain("auni-touch-target");
  expect(html).toContain("Hyperliquid");
  expect(html).toContain("<span>under</span>");
  expect(html.indexOf("Perps")).toBeLessThan(html.indexOf("under"));
  expect(html).toContain("tabular-nums");

  const link = renderToStaticMarkup(
    <Row asChild title="Money">
      <a href="/app" />
    </Row>,
  );
  expect(link).toMatch(/^<a href="\/app" data-slot="row"/u);
});

it("stays a quiet div when it only says something", () => {
  const html = renderToStaticMarkup(<Row title="Kintsu" />);
  expect(html).toMatch(/^<div data-slot="row"/u);
  expect(html).not.toContain("cursor-pointer");
});
