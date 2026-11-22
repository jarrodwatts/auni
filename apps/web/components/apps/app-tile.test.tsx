import type { AppWire } from "@auni/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { AppTile } from "./app-tile";

const app = (fields: Partial<AppWire>): AppWire => ({
  id: "venue",
  name: "Venue",
  does: "Trade there",
  canSwitch: true,
  on: true,
  jobs: [],
  inUse: true,
  standing: null,
  needs: [],
  pairing: null,
  troubles: [],
  settings: [],
  account: null,
  stays: null,
  ...fields,
});
const tile = (fields: Partial<AppWire>) =>
  renderToStaticMarkup(<AppTile app={app(fields)} onOpen={() => {}} />);

// A tile whose app kept failing said "Not working" with a "Set up" button beside it (2026-11-14).
it("offers Set up for what the owner has left to give, and not beside a trouble of the service's own", () => {
  const failing = { short: "Not working", says: "Reading its statement failed at 12:55 AM." };
  const trouble = tile({ troubles: [failing] });
  expect(trouble).toContain("Not working");
  expect(trouble).toContain("Open it to see why");
  expect(trouble).not.toContain("Set up");

  const key = {
    key: "apiKey",
    label: "API key",
    kind: "secret",
    required: true,
    help: null,
    set: null,
    untried: false,
    field: "setting:venue:apiKey",
    env: "VENUE_API_KEY",
  } as const;
  const needsKey = tile({ needs: ["Needs an API key"], settings: [key] });
  expect(needsKey).toContain("Needs a key");
  expect(needsKey).toContain("Set up");
});
