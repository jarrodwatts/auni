import type { Feedback } from "@auni/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { FeedbackBody } from "./feedback-body";

const BUG: Feedback = {
  kind: "bug",
  heading: "Report a problem",
  why: "Auni's maintainers read every report.",
  title: "Bug: a stake failed",
  always: [{ field: "what", label: "What happened", value: "The stake failed." }],
  optional: [
    {
      field: "steps",
      label: "The steps that worked",
      value: "Called 0x1234abcd on Kintsu",
      warning: "Posted soon after, these can show which wallet is yours.",
    },
    {
      field: "error",
      label: "The error",
      value: "execution reverted",
      warning: "It is the service's own words.",
    },
  ],
  search: "stake",
};

it("starts with every part that could point at the owner's wallet unticked", () => {
  const html = renderToStaticMarkup(<FeedbackBody feedback={BUG} />);
  const ticks = [...html.matchAll(/role="checkbox" aria-checked="(\w+)"/gu)].map(
    ([, checked]) => checked,
  );
  expect(ticks).toEqual(["false", "false"]);
});
