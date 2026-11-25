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
