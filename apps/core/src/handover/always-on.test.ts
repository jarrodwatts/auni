import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import type { UpReport } from "../always-on.ts";
import { setUpAlwaysOn } from "./always-on.ts";

/** A stand-in for `auni up`, which prints `report` as --json would and records how it was run. */
const standIn = vi.hoisted(() => ({ script: "" }));
vi.mock("../release/layout.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selfCommand: () => [process.execPath, standIn.script],
}));

function upPrints(report: UpReport): string {
  const folder = tempDir("auni-up-");
  const args = join(folder, "args.json");
  standIn.script = join(folder, "up.mjs");
  writeFileSync(
    standIn.script,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(JSON.stringify(report))});
process.exitCode = ${report.ok ? 0 : 1};`,
  );
  return args;
}

const AT = { address: "https://box.tail1234.ts.net:8444", port: 8444 };
const SERVE = "sudo tailscale serve --bg --https=8444 unix:/home/me/.auni/serve/auni.sock";
const report = (ok: boolean): UpReport => ({
  ok,
  address: AT.address,
  owner: "owner@example.com",
  machine: "box",
  steps: [
    { step: "tailscale", status: "done", says: "On your tailnet as box.tail1234.ts.net." },
    { step: "port", status: "done", says: "Port 8444 is Auni's." },
    ...(ok
      ? []
      : [
          {
            step: "serve" as const,
            status: "fix" as const,
            says: "Tailscale sends requests to Auni's door once root says so.",
            run: SERVE,
          },
        ]),
  ],
  staysOn: { stays: true, laptop: false, says: "Auni starts when this machine does." },
});

describe("always-on setup at the end of a takeover", () => {
  it("runs auni up on the port the laptop was told, and asks nothing", async () => {
    const args = upPrints(report(true));
    const said: string[] = [];
    expect(await setUpAlwaysOn({}, AT, (text) => said.push(text))).toBe(true);
    expect(JSON.parse(readFileSync(args, "utf8"))).toEqual([
      "up",
      "--always-on",
      "--port",
      "8444",
      "--json",
    ]);
    expect(said.join("\n")).toContain(`Auni is always on at ${AT.address}`);
  });

  // Serving a unix socket takes root, which --json never asks for: the owner reads the command.
  it("says the sudo line as what's left where root was needed, never failing quietly", async () => {
    upPrints(report(false));
    const said: string[] = [];
    expect(await setUpAlwaysOn({}, AT, (text) => said.push(text))).toBe(false);
    expect(said.at(-1)).toBe(
      `\nWhat's left is yours to run on this machine, then open ${AT.address}:\n  ${SERVE}`,
    );
  });

  it("says so when setup stops before its report", async () => {
    standIn.script = join(tempDir("auni-up-"), "up.mjs");
    writeFileSync(standIn.script, "process.exit(3);");
    const said: string[] = [];
    expect(await setUpAlwaysOn({}, AT, (text) => said.push(text))).toBe(false);
    expect(said.at(-1)).toMatch(/stopped before it said how it went/u);
  });
});
