import { describe, expect, it } from "vitest";

import { parseArgs, USAGE } from "./cli-args.ts";

describe("parseArgs", () => {
  it("reads bare flags as the start's, and a first word as the command", () => {
    expect(parseArgs([])).toEqual({ command: "", flags: new Map() });
    expect(parseArgs(["--no-open", "--no-jobs"])).toEqual({
      command: "",
      flags: new Map([
        ["--no-open", true],
        ["--no-jobs", true],
      ]),
    });
    expect(parseArgs(["update", "--version", "v0.1.2"])).toEqual({
      command: "update",
      flags: new Map([["--version", "v0.1.2"]]),
    });
    expect(parseArgs(["service", "install"])).toEqual({
      command: "service",
      flags: new Map(),
      word: "install",
    });
    expect(parseArgs(["--version"])).toEqual({ command: "--version", flags: new Map() });
  });

  it("answers --help after a command with its help, so it runs nothing", () => {
    for (const command of ["uninstall", "update", "stop", "pair", "service"]) {
      const parsed = parseArgs([command, "--help"]);
      expect(parsed).toHaveProperty("help");
      expect(parsed).not.toHaveProperty("command");
    }
    expect(parseArgs(["uninstall", "--help"])).toEqual({
      help: expect.stringContaining("Usage: auni uninstall [--yes]") as string,
    });
    expect(parseArgs(["--help"])).toEqual({ help: USAGE });
    expect(parseArgs(["help"])).toEqual({ help: USAGE });
  });

  it("keeps advanced flags in per-command help", () => {
    expect(USAGE).toContain("Start here\n  auni");
    expect(USAGE).not.toContain("--finish");
    expect(parseArgs(["take-over", "--help"])).toEqual(parseArgs(["help", "take-over"]));
    expect(parseArgs(["help", "start"])).toHaveProperty(
      "help",
      expect.stringContaining("--no-open"),
    );
    expect(parseArgs(["doctor", "--verbose"])).toEqual({
      command: "doctor",
      flags: new Map([["--verbose", true]]),
    });
  });

  it("refuses a flag the command doesn't take, with that command's usage", () => {
    expect(parseArgs(["stop", "--yes"])).toEqual({
      refused: expect.stringMatching(
        /^auni stop doesn't take --yes\.\n\nUsage: auni stop/u,
      ) as string,
    });
    expect(parseArgs(["--no-opne"])).toEqual({
      refused: expect.stringContaining("auni doesn't take --no-opne.") as string,
    });
    expect(parseArgs(["doctor", "--jsno"])).toHaveProperty("refused");
    expect(parseArgs(["update", "--version"])).toEqual({
      refused: expect.stringContaining("--version needs a value.") as string,
    });
    expect(parseArgs(["service"])).toHaveProperty("refused");
    expect(parseArgs(["service", "start"])).toHaveProperty("refused");
    expect(parseArgs(["upgrade"])).toEqual({
      refused: expect.stringContaining('auni has no command "upgrade".') as string,
    });
  });
});
