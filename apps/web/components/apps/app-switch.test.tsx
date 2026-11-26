import type { AppWire } from "@auni/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { AppSwitch } from "./app-switch";

vi.mock("@/lib/data/apps", () => ({ useSwitchApp: () => async () => {} }));

const app: AppWire = {
  id: "hyperliquid",
  name: "Hyperliquid",
  does: "Trade perps",
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
};

// Its name was the word beside it, "On" or "Off": its state, which a switch says for itself
// (2026-11-16).
it("is named for the app it turns on and off", () => {
  const drawn = renderToStaticMarkup(
    <AppSwitch app={app} name="Hyperliquid" busy={false} onAsk={() => {}} />,
  );
  const control = /<button[^>]*role="switch"[^>]*>/u.exec(drawn)?.[0] ?? "";
  expect(control).toContain('aria-label="Hyperliquid"');
  expect(control).not.toContain("aria-labelledby");
  // What on means, read after its name.
  const described = /aria-describedby="([^"]+)"/u.exec(control)?.[1];
  expect(drawn).toMatch(
    new RegExp(`id="${described}"[^>]*>Auni can use Hyperliquid when it helps<`, "u"),
  );
});

// Polymarket, on with $408.58 there and its keys not given, drew no switch at all: the only way
// on was pasting keys the owner may not want to give, and there was no way off (2026-11-25).
it("can be turned off while it waits for its keys, money there or not", () => {
  const waiting: AppWire = {
    ...app,
    id: "polymarket",
    name: "Polymarket",
    needs: ["Needs 3 keys"],
    settings: ["apiKey", "secret", "passphrase"].map((key) => ({
      key,
      label: key,
      kind: "secret",
      required: true,
      help: null,
      set: null,
      untried: false,
      field: "setting:polymarket",
      env: key.toUpperCase(),
    })),
    account: { usd: "408.58", holdings: [], moneyIn: null, moneyOut: null },
  };
  const drawn = renderToStaticMarkup(
    <AppSwitch app={waiting} name="Polymarket" busy={false} onAsk={() => {}} />,
  );
  expect(drawn).toMatch(
    /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/u,
  );
  expect(drawn).toContain("Waiting for your keys");
  expect(drawn).toContain("Auni can do more on Polymarket once they&#x27;re saved.");
});
