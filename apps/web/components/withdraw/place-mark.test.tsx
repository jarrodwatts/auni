import { NETWORKS } from "@auni/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { PlaceMark } from "./place-mark";

// The review drew Monad's mark above "Your exchange", which reads as the exchange being Monad
// (review of 2026-11-25).
it("draws whose a place is, with its network only as a small badge", () => {
  const mark = (destination: "exchange" | "wallet" | null) =>
    renderToStaticMarkup(<PlaceMark destination={destination} network="monad" size={40} />);
  expect(mark("exchange")).toContain("lucide-landmark");
  expect(mark("wallet")).toContain("lucide-wallet");
  expect(mark(null)).toContain("lucide-map-pin");
  // Monad's mark is the badge, never the face: it sits in the small disc, the only image there.
  const exchange = mark("exchange");
  expect(exchange.match(/<img /gu)).toHaveLength(1);
  expect(exchange).toMatch(
    new RegExp(`style="width:18px;height:18px"><img [^>]*src="${NETWORKS.monad.logo}"`, "u"),
  );
});
