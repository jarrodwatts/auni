import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { TakeChange } from "./take-change";

const text = (cents: bigint, savings = false) =>
  renderToStaticMarkup(
    <TakeChange change={{ amount: cents * 10_000n, percent: 0.4 }} savings={savings} />,
  ).replace(/<[^>]+>/g, "");

// A savings take read "$0 (0.0%)" in grey, as if it had lost its chance to earn (2026-11-25).
it("says what savings earned, or that they've earned nothing yet", () => {
  expect(text(1502n, true)).toBe("+$15.02 earned");
  expect(text(0n, true)).toBe("No interest yet");
  expect(text(1502n)).toBe("+$15.02 (0.4%) since entry");
});
