import type { BrainsWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { nothingThinks, readyBrain } from "./first-run";

const row = (id: string, state: "ready" | "signed-out"): BrainsWire["rows"][number] => ({
  row:
    state === "ready"
      ? { id, name: id, state, login: "your login" }
      : { id, name: id, state, fix: "sign in" },
  task: null,
  canInstall: true,
  canSignIn: true,
});

describe("readyBrain", () => {
  it("is the first AI that can think, or none", () => {
    expect(readyBrain([])).toBeNull();
    expect(readyBrain([row("codex", "signed-out")])).toBeNull();
    expect(readyBrain([row("codex", "signed-out"), row("claude-code", "ready")])).toEqual({
      id: "claude-code",
      name: "claude-code",
    });
  });
});

describe("nothingThinks", () => {
  const brains = (rows: BrainsWire["rows"], blocked: string | null = null): BrainsWire => ({
    rows,
    blocked,
    machine: "this computer",
  });

  it("is known only when the brains were read, none thinks, and nothing blocks them all", () => {
    expect(nothingThinks(undefined)).toBe(false);
    expect(nothingThinks(brains([row("codex", "signed-out")]))).toBe(true);
    expect(nothingThinks(brains([row("claude-code", "ready")]))).toBe(false);
    // A sandbox missing is no AI to sign in: core says so another way.
    expect(nothingThinks(brains([row("codex", "signed-out")], "bwrap is missing"))).toBe(false);
  });
});
