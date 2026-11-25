import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderScene, standingX, type SceneState } from "./scene.ts";
import { redraw } from "./stage.ts";
import { colorMode, plainTelling, scenePlays, takeOutput } from "./telling.ts";

const terminal = { isTTY: true, columns: 100, rows: 30 };

describe("whether the scene plays", () => {
  it("plays only in a real terminal with room for it", () => {
    expect(scenePlays(terminal, {})).toBe(true);
    // A pipe, a coding agent's shell, a service's log.
    expect(scenePlays({ ...terminal, isTTY: false }, {})).toBe(false);
    expect(scenePlays({}, {})).toBe(false);
    expect(scenePlays({ ...terminal, columns: 50 }, {})).toBe(false);
    expect(scenePlays({ ...terminal, rows: 12 }, {})).toBe(false);
  });

  it("fits the default 80 by 24 terminal", () => {
    expect(scenePlays({ isTTY: true, columns: 80, rows: 24 }, {})).toBe(true);
  });

  it("leaves dumb terminals and CI to plain lines", () => {
    expect(scenePlays(terminal, { TERM: "dumb" })).toBe(false);
    expect(scenePlays(terminal, { CI: "true" })).toBe(false);
  });
});

describe("colour", () => {
  it("is none where NO_COLOR says so, true colour where the terminal says it has it", () => {
    expect(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
    expect(colorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorMode({ COLORTERM: "24bit" })).toBe("truecolor");
    expect(colorMode({})).toBe("256");
  });
});

describe("plain lines", () => {
  it("report each stage as it happens", () => {
    const said: string[] = [];
    const told = plainTelling((line) => said.push(line));
    told.memoryReady();
    told.memoryReady();
    told.firstRun(true);
    told.brain({ name: "Claude Code", line: "Auni thinks with Claude Code, on your login." });
    told.log("Auni's API is listening on 127.0.0.1:4000.");
    told.pageBuilding();
    told.pageReady();
    told.leaving();
    told.say("\nAuni is open in your browser, at http://localhost:3000");
    told.up(true);
    expect(said).toEqual([
      "Memory ready.",
      "Auni thinks with Claude Code, on your login.",
      "Auni's API is listening on 127.0.0.1:4000.",
      "Building the web app.",
      "\nAuni is open in your browser, at http://localhost:3000",
    ]);
  });

  it("say at once why Auni waits", () => {
    const said: string[] = [];
    plainTelling((line) => said.push(line)).waiting("Auni's database is in use.");
    expect(said).toEqual(["Auni's database is in use."]);
  });

  it("say what to run when no AI can think yet", () => {
    const said: string[] = [];
    plainTelling((line) => said.push(line)).brain({
      name: null,
      line: "Auni has nothing to think with yet.",
    });
    expect(said).toEqual(["Auni has nothing to think with yet."]);
  });
});

describe("each frame", () => {
  const SYNC_START = "\u001B[?2026h";
  const SYNC_END = "\u001B[?2026l";

  it("is drawn whole the first time, inside synchronized output", () => {
    const frame = redraw([], ["a", "b"]);
    expect(frame.startsWith(SYNC_START) && frame.endsWith(SYNC_END)).toBe(true);
    expect(frame).toContain("\u001B[2Ka\n\u001B[2Kb\n");
  });

  it("redraws only the rows that changed, leaving the cursor under the scene", () => {
    // Up from under the third row to the second, write it, then down past the third.
    expect(redraw(["a", "b", "c"], ["a", "B", "c"])).toBe(
      "\u001B[?2026h\u001B[2F\u001B[2KB\n\u001B[1E\u001B[?2026l",
    );
    expect(redraw(["a", "b"], ["a", "b"])).toBe("");
  });

  it("clears what is left under a shorter frame, and grows under a longer one", () => {
    expect(redraw(["a", "b", "c"], ["a"])).toBe("\u001B[?2026h\u001B[2F\u001B[J\u001B[?2026l");
    expect(redraw(["a"], ["a", "b"])).toBe("\u001B[?2026h\u001B[2Kb\n\u001B[?2026l");
    expect(redraw(["a", "b"], [])).toBe("\u001B[?2026h\u001B[2F\u001B[J\u001B[?2026l");
  });

  it("stays well under what a terminal reads at once, even as Auni hops", () => {
    const at = (x: number, lift: number, squash: number): SceneState => ({
      stones: [
        { label: "memory", state: "ready" },
        { label: "your page", state: "working" },
        { label: "brain", state: "waiting" },
      ],
      auni: { x, lift, face: "open", look: 0, squash },
      bubble: { text: "Setting out your page", shown: 21 },
      notes: [],
      tick: 0,
    });
    let before: string[] = [];
    let largest = 0;
    for (let step = 0; step <= 30; step++) {
      const t = step / 30;
      const lines = renderScene(
        at(standingX(0) + (standingX(1) - standingX(0)) * t, 7 * Math.sin(Math.PI * t), -0.2),
        "truecolor",
      );
      if (step > 0) largest = Math.max(largest, Buffer.byteLength(redraw(before, lines)));
      before = lines;
    }
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThan(3_000);
  });
});

describe("what else is printed under the scene", () => {
  const streams = () => {
    const terminal: string[] = [];
    const stream = (to: string) => ({
      write: (chunk: string | Uint8Array) => terminal.push(`${to}:${String(chunk)}`) > 0,
    });
    return { terminal, out: stream("out"), err: stream("err") };
  };

  it("waits, then goes to Auni's log once Auni is up, and never reaches the terminal", () => {
    const { terminal, out, err } = streams();
    const route = takeOutput(out, err);
    out.write("API listening\n");
    route.toLog(join(mkdtempSync(join(tmpdir(), "auni-log-")), "auni.log"));
    err.write("Base's RPC keeps no past balances\n");
    expect(terminal).toEqual([]);
  });

  it("keeps what was held, then each later line, in order, in the log", () => {
    const { out, err } = streams();
    const route = takeOutput(out, err);
    const file = join(mkdtempSync(join(tmpdir(), "auni-log-")), "auni.log");
    out.write("one\n");
    route.toLog(file);
    err.write("two\n");
    out.write("three\n");
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("is the terminal's again as Auni stops, what was held first", () => {
    const { terminal, out, err } = streams();
    const route = takeOutput(out, err);
    err.write("Auni is already running.\n");
    route.toTerminal();
    out.write("Auni is stopping\n");
    expect(terminal).toEqual(["err:Auni is already running.\n", "out:Auni is stopping\n"]);
  });

  it("is the terminal's after the log, too, once Auni stops", () => {
    const { terminal, out, err } = streams();
    const route = takeOutput(out, err);
    route.toLog(join(mkdtempSync(join(tmpdir(), "auni-log-")), "auni.log"));
    out.write("a turn ran\n");
    route.toTerminal();
    out.write("Auni is stopping\n");
    expect(terminal).toEqual(["out:Auni is stopping\n"]);
  });

  it("reaches the terminal as Auni exits before the scene is done, the scene cleared first", () => {
    // `auni` with a setting it can't read says why on stderr and exits, before Auni is up.
    const { terminal, out, err } = streams();
    const ends = new EventEmitter();
    takeOutput(out, err, { ends, beforeTerminal: () => terminal.push("cleared") });
    err.write("Invalid environment configuration: WEB_ORIGIN: Invalid URL\n");
    ends.emit("exit", 1);
    expect(terminal).toEqual([
      "cleared",
      "err:Invalid environment configuration: WEB_ORIGIN: Invalid URL\n",
    ]);
  });

  it("reaches the terminal before an error that ends Auni is printed there", () => {
    const { terminal, out, err } = streams();
    const ends = new EventEmitter();
    takeOutput(out, err, { ends });
    out.write("Waking up\n");
    ends.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");
    expect(terminal).toEqual(["out:Waking up\n"]);
  });

  it("stays in the log as Auni exits, once it went there", () => {
    const { terminal, out, err } = streams();
    const ends = new EventEmitter();
    takeOutput(out, err, { ends }).toLog(
      join(mkdtempSync(join(tmpdir(), "auni-log-")), "auni.log"),
    );
    out.write("a turn ran\n");
    ends.emit("exit", 0);
    expect(terminal).toEqual([]);
  });

  it("stays on the terminal when the log can't be opened", () => {
    const { terminal, out, err } = streams();
    const route = takeOutput(out, err);
    out.write("held\n");
    route.toLog("/nonexistent/folder/auni.log");
    out.write("after\n");
    expect(terminal).toEqual(["out:held\n", "out:after\n"]);
  });
});
