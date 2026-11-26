import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { NeedsYouPlace } from "./needs-you-place";

const SALE = "Sell up to 310 shares, at least $191.68 back if all 310 sell";

vi.mock("./use-places", () => ({
  usePlaces: () => ({
    needsYou: [{ thread: { id: "t1", title: "Sell half of my Fed bet", moneyLine: SALE } }],
  }),
}));
vi.mock("./open-place", () => ({ PlaceLink: (props: object) => <a {...props} /> }));
vi.mock("./place-header", () => ({ PlaceHeader: () => null }));

// A phone's Needs you cut "at least $191.68 back if all 310 s…" off at 390px: the floor was
// shown without the condition it holds under (2026-11-26 council). Its row now wraps.
it("shows a waiting card's line in full, wrapping rather than cutting off its condition", () => {
  const html = renderToStaticMarkup(<NeedsYouPlace />);
  const line = html.match(/<span class="([^"]*)"><span class="text-waiting">([^<]*)</u);
  expect(line?.[2]).toBe(SALE);
  expect(line?.[1]).not.toContain("truncate");
});
