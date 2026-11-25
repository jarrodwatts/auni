import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "./db/client.ts";
import { ownerSessions } from "./db/schema.ts";
import { env } from "./env.ts";
import { browserTried, canOpenBrowser, openBrowser } from "./open-browser.ts";
import { onStopAsked, openOwner } from "./start.ts";
import { wipe } from "./test/db.ts";

vi.mock("./open-browser.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  canOpenBrowser: vi.fn(),
  openBrowser: vi.fn(),
}));

let said: string;
beforeEach(async () => {
  await wipe(ownerSessions);
  vi.clearAllMocks();
  vi.mocked(canOpenBrowser).mockReturnValue(true);
  vi.mocked(openBrowser).mockResolvedValue();
  said = "";
  vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => {
    said += `${line.join(" ")}\n`;
  });
});
afterEach(() => vi.restoreAllMocks());

const opened = () => vi.mocked(openBrowser).mock.calls.map(([url]) => url);
const codes = () => db.select().from(ownerSessions);
const pairBrowser = () =>
  db.insert(ownerSessions).values({
    tokenHash: "session",
    kind: "session",
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });

describe("openOwner", () => {
  it("skips the browser and pairing entirely when the web app is off", async () => {
    expect(await openOwner({ web: false, open: true, printsLink: true })).toBe(false);
    expect(opened()).toEqual([]);
    expect(await codes()).toEqual([]);
    expect(said).toBe("");
  });

  it("opens the pairing link in the browser while none is paired, and never prints it", async () => {
    await openOwner({ web: true, open: true });
    expect(opened()).toEqual([
      expect.stringMatching(new RegExp(`^${env.WEB_ORIGIN}/app#pair=.+`, "u")),
    ]);
    expect(said).toContain(`Auni is open in your browser.\n${env.WEB_ORIGIN}`);
    expect(said).not.toContain("#pair");
    expect(said).not.toContain(opened()[0]!.split("=")[1]);
    expect(browserTried()?.how).toBe("opened");
  });

  it("opens the app once a browser is paired, minting no code", async () => {
    await pairBrowser();
    await openOwner({ web: true, open: true });
    expect(opened()).toEqual([`${env.WEB_ORIGIN}/app`]);
    expect((await codes()).map(({ kind }) => kind)).toEqual(["session"]);
  });

  it("says where Auni is and how to pair, when it isn't to open a browser", async () => {
    await openOwner({ web: true, open: false });
    expect(opened()).toEqual([]);
    expect(await codes()).toEqual([]);
    expect(said).toContain(`Auni is at ${env.WEB_ORIGIN}`);
    expect(said).toContain("auni pair");
  });

  it("says the same when there's no screen, or the browser didn't open, and records which", async () => {
    vi.mocked(canOpenBrowser).mockReturnValue(false);
    await openOwner({ web: true, open: true });
    expect(opened()).toEqual([]);
    expect(browserTried()?.how).toBe("no-screen");
    vi.mocked(canOpenBrowser).mockReturnValue(true);
    vi.mocked(openBrowser).mockRejectedValue(new Error("xdg-open exited 3"));
    await openOwner({ web: true, open: true });
    expect(browserTried()?.how).toBe("not-opened");
    expect(said).not.toContain("#pair");
    expect(said.match(/auni pair/gu)).toHaveLength(2);
    expect(said.match(/ssh -L/gu)).toHaveLength(1);
    expect(said.indexOf("ssh -L")).toBeLessThan(said.indexOf(env.WEB_ORIGIN));
  });

  it("brings the browser to the page a start names, by the link it opens or prints", async () => {
    await openOwner({ web: true, open: true, landsOn: "/app/new" });
    expect(opened()).toEqual([
      expect.stringMatching(new RegExp(`^${env.WEB_ORIGIN}/app/new#pair=.+`, "u")),
    ]);
    // A demo, with nothing to open a browser in, prints the same link.
    vi.mocked(canOpenBrowser).mockReturnValue(false);
    said = "";
    await openOwner({ web: true, open: true, printsLink: true, landsOn: "/app/new" });
    expect(said).toMatch(new RegExp(`Open ${env.WEB_ORIGIN}/app/new#pair=\\S+`, "u"));
    expect(said).toContain(
      `ssh -L ${new URL(env.WEB_ORIGIN).port}:127.0.0.1:${env.WEB_PORT} <this computer>`,
    );
    expect(said.indexOf("ssh -L")).toBeLessThan(said.indexOf(env.WEB_ORIGIN));
  });

  it("asks a paired owner for no pairing link", async () => {
    await pairBrowser();
    await openOwner({ web: true, open: false });
    expect(said).toContain(`Open Auni at ${env.WEB_ORIGIN}`);
    expect(said).not.toContain("auni pair");
  });
});

describe("onStopAsked", () => {
  it("stops gently on every SIGTERM, so auni stop asked twice cuts nothing short", () => {
    const signals = new EventEmitter();
    const stop = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    onStopAsked(stop, signals);
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it("stops gently when its terminal window closes, so its Postgres stops with it", () => {
    const signals = new EventEmitter();
    const stop = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    onStopAsked(stop, signals);
    signals.emit("SIGHUP");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    // The closed terminal refusing a write is no reason to die before Postgres is stopped.
    expect(() => process.stdout.emit("error", new Error("EIO"))).not.toThrow();
  });

  it("stops at once on a second Ctrl-C, but not on one press that arrives twice", () => {
    vi.useFakeTimers();
    try {
      const signals = new EventEmitter();
      const stop = vi.fn();
      const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      onStopAsked(stop, signals);
      signals.emit("SIGINT");
      signals.emit("SIGINT");
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_500);
      signals.emit("SIGINT");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      vi.useRealTimers();
    }
  });
});
