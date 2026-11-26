import type { AppWire } from "@auni/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { KeysSaved, Linked } from "./app-keys";

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

// With Elfa switched off, saving its key said "Elfa is connected. Auni can use it right away."
// while its switch still said off (2026-11-25).
it("says an app is connected once its key is in only when it's on", () => {
  const elfa: AppWire = {
    id: "elfa",
    name: "Elfa",
    does: "Reads social sentiment",
    canSwitch: true,
    on: false,
    jobs: [],
    inUse: true,
    standing: null,
    needs: [],
    pairing: null,
    troubles: [],
    settings: [
      {
        key: "apiKey",
        label: "Elfa API key",
        kind: "secret",
        required: true,
        help: null,
        set: "file",
        untried: false,
        field: "setting:elfa",
        env: "ELFA_API_KEY",
      },
    ],
    account: null,
    stays: null,
  };
  const off = renderToStaticMarkup(<KeysSaved app={elfa} />);
  expect(off).not.toContain("is connected");
  expect(off).toContain("Key saved");
  expect(off).toContain("Elfa is off, so Auni won&#x27;t use it until you turn it on below.");
  expect(renderToStaticMarkup(<KeysSaved app={{ ...elfa, on: true }} />)).toContain(
    "Elfa is connected",
  );
});
