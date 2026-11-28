import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import type { WalletKeys } from "../apps/contract.ts";
import { dataDir, envFile } from "../data-dir.ts";
import { db } from "../db/client.ts";
import { env } from "../env.ts";
import { insertThread } from "../test/db.ts";
import {
  lendToHandover,
  offerHandover,
  handoverState,
  packHere,
  whileHandingOver,
  type Laptop,
} from "./hand-over.ts";
import { packed } from "./bundle.ts";
import { handedOver } from "./marks.ts";
import { keysFor, newCode, proofText, seal } from "./seal.ts";
import type { Machine } from "./tailnet.ts";

// A handover from one Auni to another, the laptop's half here and the new machine's in a process of
// its own (test/take-over-child.ts) with its own data folder and database, over the loopback
// address standing in for the tailnet.

/** A throwaway wallet's keys, made for this test and holding nothing. */
const KEYS: WalletKeys = {
  evm: "0x835357a980ba95c9e91c337a94c98ec3523ba1918a1246f99dea03e427c5b3ea",
  solana: "c6ViDnX6N5jzgXcqrFRPdf7R15S8a56urXg2tW3sdtANeugsPETouxDzWytreJCGMCxHerm6iyX6RjUtZEaNDRR",
};

// The laptop's wallet: keys kept on this machine, which a handover carries.
vi.mock("../apps/registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../apps/registry.ts")>();
  return {
    ...real,
    walletApp: () => ({
      about: { ...real.walletApp().about, id: "local-key" },
      provided: {
        keptHere: { where: async () => ({ place: "here", inDataFolder: true }) },
        revealKeys: async () => KEYS,
      },
    }),
  };
});

const CHILD = fileURLToPath(new URL("../test/take-over-child.ts", import.meta.url));
const admin = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });

const machine = (fields: Partial<Machine> = {}): Machine => ({
  id: "nBOX",
  name: "box",
  os: "linux",
  online: true,
  runsAuni: true,
  dnsName: "box.tail1234.ts.net",
  ips: ["127.0.0.1"],
  here: false,
  ...fields,
});
const HERE = machine({ id: "nLAPTOP", name: "laptop", here: true });

/** The laptop's job runner, as a handover stops and starts it. */
let runner: { stops: number; starts: number };
const laptop = (pack: () => Promise<Buffer> = packHere): Laptop => ({
  stopJobs: async () => void (runner.stops += 1),
  startJobs: async () => void (runner.starts += 1),
  pack,
});

// Each test's new machine is its own, folder and database, and goes when the test ends however it
// ended: a test that timed out still runs on (vitest can't stop it), so one shared between tests
// would be the next one's too.
let tests = 0;
let target: string;
let targetName: string;
let targetUrl: string;
/** The handover this test offered, as the command it was shown names it. */
let offered: { from: string; code: string } | null = null;
/** The new machines' processes still running, stopped when their test ends. */
const children = new Set<ChildProcess>();
beforeEach(async () => {
  runner = { stops: 0, starts: 0 };
  lendToHandover(laptop());
  target = tempDir("auni-takeover-target-");
  targetName = `${new URL(env.DATABASE_URL).pathname.slice(1)}_takeover_${++tests}`;
  targetUrl = Object.assign(new URL(env.DATABASE_URL), { pathname: `/${targetName}` }).href;
  await admin.unsafe(`drop database if exists "${targetName}" with (force)`);
  await admin.unsafe(`create database "${targetName}"`);
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(envFile(), "ELFA_AUTO_API_KEY='elfa-key'\nWEB_PORT=3999\nexport PORT=4999\n");
});
afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  vi.unstubAllEnvs();
  // A laptop left handing Auni over to a machine now gone hears it declined, as it would from
  // that machine, so the next test's offer isn't turned down while this one waits two minutes.
  if (offered) {
    await vi.waitFor(() => expect(handoverState()?.stage).not.toBe("handing"), { timeout: 10_000 });
    if (handoverState()?.stage === "handed")
      await ask(offered.from, "/handover/declined", proofText(await keysFor(offered.code)));
    offered = null;
  }
  await admin.unsafe(`drop database if exists "${targetName}" with (force)`);
  rmSync(join(dataDir(), "handed-over.json"), { force: true });
  rmSync(envFile(), { force: true });
});
afterAll(() => admin.end());

/** Until the laptop's handover has ended, for that reason: on its own timers, so no sooner. */
const ended = (why: string) =>
  vi.waitFor(() => expect(handoverState()).toMatchObject({ stage: "ended", ended: why }), {
    timeout: 10_000,
  });

/** What the command the owner is shown names: the laptop's address and the code. */
function readCommand(command: string): { from: string; code: string } {
  const [, code, from] = /AUNI_HANDOVER_CODE=(\S+) .* take-over --from (\S+)$/u.exec(command) ?? [];
  offered = { from: from!, code: code! };
  return offered;
}

/** `auni take-over` on the new machine: its exit code and what it said. */
function runTakeOver(
  from: string,
  code: string,
  ...args: string[]
): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [CHILD, from, ...args], {
    env: { ...process.env, AUNI_HOME: target, DATABASE_URL: targetUrl, AUNI_HANDOVER_CODE: code },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
  child.stderr.on("data", (chunk: Buffer) => (out += String(chunk)));
  return new Promise((resolve) =>
    child.once("close", (exit) => {
      children.delete(child);
      resolve({ code: exit, out });
    }),
  );
}

/** A request to the laptop's listener, as a new machine would send it. */
async function ask(
  from: string,
  path: string,
  proof: string,
  more: { readonly address?: string } = {},
): Promise<Response> {
  return fetch(`http://${from}${path}`, {
    method: "POST",
    body: JSON.stringify({ proof, ...more }),
  });
}

const targetRows = async () => {
  const sql = postgres(targetUrl, { max: 1, onnotice: () => {} });
  try {
    return await sql<{ title: string | null }[]>`select title from threads`;
  } finally {
    await sql.end();
  }
};

// Each takeover runs as `auni take-over` would, in a node process of its own: a second or so to
// load on an idle machine, several on a busy one.
describe("handing Auni over to a machine that stays on", { timeout: 60_000 }, () => {
  it("carries the whole of Auni once, and the laptop runs nothing after", async () => {
    await insertThread({ title: "Uranium" });
    const said = vi.spyOn(console, "error");
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    expect(command).toMatch(/^curl -fsSL \S+install\.sh \| sh && AUNI_HANDOVER_CODE=/u);

    const took = await runTakeOver(from, code);
    expect(took).toMatchObject({ code: 0 });
    expect(took.out).toMatch(/Everything Auni keeps is here/u);

    // On the new machine: the database, the keys, and the owner's settings but this machine's own.
    expect(await targetRows()).toEqual([{ title: "Uranium" }]);
    expect(JSON.parse(readFileSync(join(target, "wallet-keys.json"), "utf8"))).toEqual(KEYS);
    expect(readFileSync(join(target, ".env"), "utf8")).toBe("ELFA_AUTO_API_KEY='elfa-key'\n");
    expect(existsSync(join(target, "taking-over.sealed"))).toBe(false);

    // On the laptop: stopped for good, saying where Auni went, its keys left as they were.
    expect(runner).toEqual({ stops: 1, starts: 0 });
    expect(handoverState()).toMatchObject({ stage: "taken", machine: "box" });
    // Where always-on setup will serve it there, port and all (test/take-over-child.ts).
    expect(handedOver()).toMatchObject({ to: "https://box.tail1234.ts.net:8444", machine: "box" });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    whileHandingOver({ method: "GET" } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);

    // The code worked once: a second machine with it gets nothing.
    expect((await ask(from, "/handover/bundle", proofText(await keysFor(code)))).status).toBe(410);
    // And the laptop, asked again whether it let go (an answer lost), says the same.
    expect((await ask(from, "/handover/opened", proofText(await keysFor(code)))).status).toBe(200);

    // No key reached anything said, on either machine.
    const everything = [took.out, ...said.mock.calls.flat().map(String)].join("\n");
    expect(everything).not.toContain(KEYS.evm!.slice(2));
    expect(everything).not.toContain(KEYS.solana!);
    expect(everything).not.toContain(code);
    said.mockRestore();
  });

  it("sends the owner nowhere but the machine they picked", async () => {
    vi.stubEnv("ALWAYS_ON_AT", "https://elsewhere.example.com");
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    const took = await runTakeOver(from, code);
    vi.unstubAllEnvs();
    expect(took).toMatchObject({ code: 1 });
    expect(took.out).toMatch(/won't send you to https:\/\/elsewhere\.example\.com/u);
    // Not handed over: the laptop runs again, and the new machine holds nothing.
    expect(handedOver()).toBeNull();
    expect(runner).toEqual({ stops: 1, starts: 1 });
    expect(existsSync(join(target, "wallet-keys.json"))).toBe(false);
    expect(existsSync(join(target, "taking-over.sealed"))).toBe(false);
  });

  it("refuses a machine that can't be always on, while the laptop carries on", async () => {
    vi.stubEnv("ALWAYS_ON_AT", "none");
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    const took = await runTakeOver(from, code);
    vi.unstubAllEnvs();
    expect(took).toMatchObject({ code: 1 });
    expect(took.out).toMatch(/Tailscale is off\. Nothing changed: Auni carries on on your laptop/u);
    expect(handedOver()).toBeNull();
    expect(runner).toEqual({ stops: 1, starts: 1 });
    expect(existsSync(join(target, "taking-over.sealed"))).toBe(false);
  });

  it("refuses a wrong code, and the laptop carries on untouched", async () => {
    const { command } = await offerHandover(machine(), HERE);
    const { from } = readCommand(command);
    const wrong = await runTakeOver(from, newCode());
    expect(wrong).toMatchObject({ code: 1 });
    expect(wrong.out).toMatch(/didn't take that code/u);
    expect(runner).toEqual({ stops: 0, starts: 0 });
    expect(handoverState()).toMatchObject({ stage: "waiting" });
    expect(await targetRows().catch(() => "no tables")).toBe("no tables");
    // Five wrong codes close it for good.
    for (let tries = 2; tries <= 5; tries++)
      await ask(from, "/handover/bundle", proofText(await keysFor(newCode())));
    expect(handoverState()).toMatchObject({ stage: "ended", ended: "wrong_code" });
    expect(runner).toEqual({ stops: 0, starts: 0 });
  });

  it("refuses an expired code, and the laptop carries on untouched", async () => {
    const { command } = await offerHandover(machine(), HERE, { forMs: 200 });
    const { from, code } = readCommand(command);
    await ended("expired");
    const late = await runTakeOver(from, code);
    expect(late).toMatchObject({ code: 1 });
    expect(late.out).toMatch(/Couldn't reach Auni on your laptop/u);
    expect(handoverState()).toMatchObject({ stage: "ended", ended: "expired" });
    expect(runner).toEqual({ stops: 0, starts: 0 });
  });

  it("hands Auni only to the machine the owner picked", async () => {
    const { command } = await offerHandover(machine({ ips: ["100.64.0.9"] }), HERE);
    const { from, code } = readCommand(command);
    const elsewhere = await runTakeOver(from, code);
    expect(elsewhere.out).toMatch(/waiting for another machine/u);
    expect(runner).toEqual({ stops: 0, starts: 0 });
    expect(handoverState()).toMatchObject({ stage: "waiting" });
  });

  it("never takes Auni over into a machine that holds one, and spends no code on one", async () => {
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    writeFileSync(join(target, ".env"), "PORT=4100\n");
    const holds = await runTakeOver(from, code);
    expect(holds).toMatchObject({ code: 1 });
    expect(holds.out).toMatch(/holds an Auni already \(its settings/u);
    rmSync(join(target, ".env"));
    // Its database used already.
    const sql = postgres(targetUrl, { max: 1, onnotice: () => {} });
    await sql`create table kept (id int)`;
    await sql.end();
    expect((await runTakeOver(from, code)).out).toMatch(/holds an Auni already \(its database/u);
    expect(runner).toEqual({ stops: 0, starts: 0 });
    expect(handoverState()).toMatchObject({ stage: "waiting" });
  });

  it("takes Auni back when the transfer is cut off midway", async () => {
    // A bundle big enough to be cut off as it goes.
    lendToHandover(laptop(async () => Buffer.alloc(32 * 1024 * 1024, 1)));
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    const [host, port] = from.split(":");
    const proof = proofText(await keysFor(code));
    await new Promise<void>((resolve) => {
      const req = request({ host, port, method: "POST", path: "/handover/bundle" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.end(JSON.stringify({ proof }));
    });
    await ended("cut_short");
    expect(runner).toEqual({ stops: 1, starts: 1 });
    expect(handedOver()).toBeNull();
  });

  it("takes Auni back when the new machine never says it opened the bundle", async () => {
    const { command } = await offerHandover(machine(), HERE, { answerMs: 300 });
    const { from, code } = readCommand(command);
    const response = await ask(from, "/handover/bundle", proofText(await keysFor(code)));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(handoverState()).toMatchObject({ stage: "handed" });
    await ended("no_answer");
    expect(runner).toEqual({ stops: 1, starts: 1 });
    expect(handedOver()).toBeNull();
  });

  it("takes Auni back at once when the new machine can't read it", async () => {
    // An export from a newer Auni than the new machine's.
    const newer = gzipSync(
      `${JSON.stringify({ auni: "export", version: "9.0.0", schema: 9e15 })}\n`,
    );
    lendToHandover(
      laptop(async () =>
        packed({
          version: "9.0.0",
          wallet: { app: "local-key", keys: KEYS },
          settings: "",
          export: newer,
        }),
      ),
    );
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    const declined = await runTakeOver(from, code);
    expect(declined).toMatchObject({ code: 1 });
    expect(declined.out).toMatch(/runs Auni v9\.0\.0, newer than this machine's/u);
    expect(handoverState()).toMatchObject({ stage: "ended", ended: "declined" });
    expect(runner).toEqual({ stops: 1, starts: 1 });
    expect(existsSync(join(target, "wallet-keys.json"))).toBe(false);
    expect(existsSync(join(target, "taking-over.sealed"))).toBe(false);
  });

  it("starts afresh with a new code over what a takeover cut off before the laptop let go left", async () => {
    writeFileSync(
      join(target, "taking-over.sealed"),
      seal(await keysFor(newCode()), Buffer.from("{}")),
    );
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    expect(await runTakeOver(from, code)).toMatchObject({ code: 0 });
    expect(handoverState()).toMatchObject({ stage: "taken" });
  });

  it("finishes a takeover whose laptop let go but can't be reached again (--finish)", async () => {
    await insertThread({ title: "Gold" });
    const { command } = await offerHandover(machine(), HERE);
    const { from, code } = readCommand(command);
    const proof = proofText(await keysFor(code));
    // A new machine that fetched the bundle, heard the laptop let go, and was cut off.
    const sealed = Buffer.from(await (await ask(from, "/handover/bundle", proof)).arrayBuffer());
    writeFileSync(join(target, "taking-over.sealed"), sealed);
    // Saying where Auni will be, which the laptop takes only on the machine it picked.
    expect((await ask(from, "/handover/opened", proof)).status).toBe(400);
    const address = "https://box.tail1234.ts.net";
    expect((await ask(from, "/handover/opened", proof, { address })).status).toBe(200);
    expect(handedOver()).toMatchObject({ to: address });

    // Resumed once the laptop let go, a machine not ready to be always on keeps the bundle.
    vi.stubEnv("ALWAYS_ON_AT", "none");
    const early = await runTakeOver("127.0.0.1:1", code, "--finish");
    vi.unstubAllEnvs();
    expect(early.out).toMatch(/Run this same command again once it can/u);
    expect(existsSync(join(target, "taking-over.sealed"))).toBe(true);

    const finished = await runTakeOver("127.0.0.1:1", code, "--finish");
    expect(finished).toMatchObject({ code: 0 });
    expect(await targetRows()).toEqual([{ title: "Gold" }]);
    expect(JSON.parse(readFileSync(join(target, "wallet-keys.json"), "utf8"))).toEqual(KEYS);
  });

  it("ends quietly without querying or packing when Auni stops during the runner drain", async () => {
    const stopping = new AbortController();
    let releaseDrain!: () => void;
    let enteredDrain!: () => void;
    const draining = new Promise<void>((resolve) => (releaseDrain = resolve));
    const entered = new Promise<void>((resolve) => (enteredDrain = resolve));
    const pack = vi.fn(packHere);
    const select = vi.spyOn(db, "select");
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      lendToHandover({
        stopJobs: async () => {
          runner.stops += 1;
          enteredDrain();
          await draining;
        },
        startJobs: async () => void (runner.starts += 1),
        pack,
        signal: stopping.signal,
      });
      const { command } = await offerHandover(machine(), HERE);
      const { from, code } = readCommand(command);
      const proof = proofText(await keysFor(code));
      const response = ask(from, "/handover/bundle", proof);
      await entered;
      expect(handoverState()).toMatchObject({ stage: "handing" });

      stopping.abort();
      releaseDrain();
      const settled = await response;
      expect(settled.status).toBe(410);
      expect(await settled.json()).toEqual({ error: "cancelled" });
      expect(select).not.toHaveBeenCalled();
      expect(pack).not.toHaveBeenCalled();
      expect(handoverState()).toMatchObject({ stage: "ended", ended: "cancelled" });
      expect(runner).toEqual({ stops: 1, starts: 0 });
      expect(said).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      said.mockRestore();
    }
  });

  it("ends quietly without logging when Auni stops while packing", async () => {
    const stopping = new AbortController();
    let failPack!: (error: Error) => void;
    let enteredPack!: () => void;
    const packing = new Promise<Buffer>((_resolve, reject) => (failPack = reject));
    const entered = new Promise<void>((resolve) => (enteredPack = resolve));
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      lendToHandover({
        ...laptop(() => {
          enteredPack();
          return packing;
        }),
        signal: stopping.signal,
      });
      const { command } = await offerHandover(machine(), HERE);
      const { from, code } = readCommand(command);
      const proof = proofText(await keysFor(code));
      const response = ask(from, "/handover/bundle", proof);
      await entered;

      stopping.abort();
      failPack(new Error("CONNECTION_ENDED"));
      const settled = await response;
      expect(settled.status).toBe(410);
      expect(await settled.json()).toEqual({ error: "cancelled" });
      expect(handoverState()).toMatchObject({ stage: "ended", ended: "cancelled" });
      expect(runner).toEqual({ stops: 1, starts: 0 });
      expect(said).not.toHaveBeenCalled();
    } finally {
      said.mockRestore();
    }
  });
});
