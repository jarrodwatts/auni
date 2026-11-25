import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dataDir } from "../data-dir.ts";
import {
  appDir,
  backupsDir,
  BUILT,
  currentTag,
  launcher,
  switchCurrent,
  versionDir,
} from "./layout.ts";
import type { RunningAuni, RunsAs } from "../running.ts";
import { checkRelease, ReleaseRefused, sourceTag } from "./check.ts";
import { update, UpdateRefused, type UpdateHost } from "./update.ts";

// The release check is install.sh's, run for real in install.test.ts; here it passes whatever
// is asked for, or v0.1.1 as the newest.
vi.mock("./check.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkRelease: vi.fn(),
  sourceTag: vi.fn(),
}));

// Real files and real processes in a scratch AUNI_HOME laid out as install.sh lays it out, each
// version a tiny auni.mjs on this Node: one that comes up (answers /core/health), and one that
// changes the database's files, as a migration would, then dies.

const SERVES = `import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
appendFileSync(process.env.AUNI_HOME + "/started-with", process.argv.slice(2).join(" ") + "\\n");
const server = createServer((_, answer) => answer.end("ok"));
server.listen(Number(process.env.HEALTH_PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
const BREAKS = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.AUNI_HOME + "/postgres/marker", "changed by the new version\\n");
console.error("the new version broke as it started");
process.exit(1);
`;
const HANGS = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.AUNI_HOME + "/postgres/marker", "changed by the new version\\n");
setInterval(() => {}, 1_000);
process.on("SIGTERM", () => process.exit(0));
`;
/** install.sh's launcher, which runs `current` on its own Node. */
const LAUNCHER = `#!/bin/sh
app="$AUNI_HOME/app/current"
PATH="$app/.node/bin:$PATH"
export PATH
exec "$app/.node/bin/node" "$app/apps/core/bin/auni.mjs" "$@"
`;

function version(tag: string, entry: string): void {
  const dir = versionDir(tag);
  mkdirSync(join(dir, "apps/core/bin"), { recursive: true });
  writeFileSync(join(dir, "apps/core/bin/auni.mjs"), entry);
  symlinkSync(dirname(dirname(process.execPath)), join(dir, ".node"));
  writeFileSync(join(dir, BUILT), "");
}

const marker = () => readFileSync(join(dataDir(), "postgres/marker"), "utf8");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

let said: string[];
let did: string[];
let port: number;
/** What a test started and leaves running: stopped after it. */
const afterwards: (() => void)[] = [];

beforeEach(async () => {
  vi.stubEnv("AUNI_HOME", mkdtempSync(join(tmpdir(), "auni-update-")));
  mkdirSync(join(appDir(), "bin"), { recursive: true });
  writeFileSync(launcher(), LAUNCHER);
  chmodSync(launcher(), 0o755);
  mkdirSync(join(appDir(), "node/24.0.0"), { recursive: true });
  mkdirSync(join(dataDir(), "postgres"), { recursive: true });
  writeFileSync(join(dataDir(), "postgres/marker"), "the owner's data\n");
  version("v0.1.0", SERVES);
  switchCurrent("v0.1.0");
  port = await freePort();
  said = [];
  did = [];
  vi.mocked(checkRelease).mockImplementation(async ({ version }) => ({
    version: version ?? "v0.1.1",
    made: "2026-11-12T10:00:00Z",
    commit: "691dcde58c1f",
    source: "0".repeat(64),
    notes: "Hyperliquid orders can be cancelled.",
  }));
  vi.spyOn(console, "log").mockImplementation((line: string) => void said.push(line));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    said.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  for (const undo of afterwards.splice(0)) undo();
  vi.mocked(checkRelease).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Auni running as `as` on this computer. */
const runs = (as: RunsAs): RunningAuni => ({ as, pid: 4242, here: true });

/**
 * This machine, with Auni running as a service, its own Postgres stopped once let go of. What
 * update starts again is the old version's tiny auni.mjs, serving as the real one would.
 */
function host(overrides: Partial<UpdateHost> = {}): UpdateHost {
  let started: ChildProcess | undefined;
  return {
    env: { ...process.env, HEALTH_PORT: String(port) },
    running: async () => runs("service"),
    stop: async ({ as }) => {
      did.push(`stop ${as}`);
      return true;
    },
    start: (as) => {
      did.push(`start ${as}`);
      started = spawn(launcher(), ["--no-open"], {
        env: { ...process.env, HEALTH_PORT: String(port) },
        stdio: "ignore",
      });
      afterwards.push(() => started?.kill("SIGTERM"));
    },
    postgres: {
      release: async () => void did.push("release"),
      hold: async () => void did.push("hold"),
      running: async () => false,
      stop: async () => void did.push("stop postgres"),
    },
    // As db/export.ts would: one file, written while the database is still held.
    export: async (file) => {
      did.push("export");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "everything Auni keeps\n");
    },
    origin: `http://127.0.0.1:${port}`,
    healthyWithinMs: 3_000,
    confirm: async (question) => {
      did.push(`asked: ${question}`);
      return true;
    },
    ...overrides,
  };
}

const all = () => said.join("\n");
const asked = "asked: Update from v0.1.0 to v0.1.1?";

describe("auni update", { timeout: 20_000 }, () => {
  it("rolls back to the old version and its data when the new one doesn't come up", async () => {
    version("v0.1.1", BREAKS);
    expect(await update({ version: "v0.1.1", host: host() })).toBe("rolled-back");
    expect(currentTag()).toBe("v0.1.0");
    expect(marker()).toBe("the owner's data\n");
    // What the new version left is kept beside it, and its output shown.
    const failed = readdirSync(dataDir()).filter((name) => name.startsWith("postgres.failed-"));
    expect(failed).toHaveLength(1);
    expect(readFileSync(join(dataDir(), failed[0]!, "marker"), "utf8")).toContain(
      "changed by the new version",
    );
    expect(all()).toContain("the new version broke as it started");
    expect(all()).toContain(
      "v0.1.1 exited during startup, so Auni rolled back to v0.1.0 with your data intact. Startup output is above.",
    );
    expect(all()).toContain(`Files left by v0.1.1 are saved at ${join(dataDir(), failed[0]!)}`);
    expect(did).toEqual([
      asked,
      "stop service",
      "hold",
      "export",
      "release",
      "release",
      "start service",
    ]);
  });

  it("keeps no more after a roll back than after an update", async () => {
    version("v0.0.9", SERVES);
    mkdirSync(join(backupsDir(), "v0.0.8-20250101T000000Z"), { recursive: true });
    mkdirSync(join(backupsDir(), "v0.0.9-20260101T000000Z"), { recursive: true });
    mkdirSync(join(dataDir(), "postgres.failed-20260101T000000Z"));
    for (const tag of ["v0.1.1", "v0.1.2"]) {
      version(tag, BREAKS);
      const stopped = host({ running: async () => null });
      expect(await update({ version: tag, host: stopped })).toBe("rolled-back");
    }
    // The versions in use, without the ones that failed.
    expect(readdirSync(join(appDir(), "versions")).sort()).toEqual(["v0.0.9", "v0.1.0"]);
    // The copy each try took is the database again, so the two copies kept are the older ones.
    expect(readdirSync(backupsDir()).sort()).toEqual([
      "v0.0.8-20250101T000000Z",
      "v0.0.9-20260101T000000Z",
    ]);
    // Only the newest that a failed version left, which is v0.1.2's.
    const failed = readdirSync(dataDir()).filter((name) => name.startsWith("postgres.failed-"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).not.toBe("postgres.failed-20260101T000000Z");
    expect(marker()).toBe("the owner's data\n");
  });

  it("switches once the new version comes up, keeping two versions and two copies", async () => {
    version("v0.0.9", SERVES);
    version("v0.1.1", SERVES);
    mkdirSync(join(backupsDir(), "v0.0.8-20250101T000000Z"), { recursive: true });
    mkdirSync(join(backupsDir(), "v0.0.9-20260101T000000Z"), { recursive: true });
    expect(await update({ version: "v0.1.1", host: host() })).toBe("updated");
    expect(currentTag()).toBe("v0.1.1");
    expect(readdirSync(join(appDir(), "versions")).sort()).toEqual(["v0.1.0", "v0.1.1"]);
    // Neither version runs on the Node 24.0.0 left from before.
    expect(existsSync(join(appDir(), "node/24.0.0"))).toBe(false);
    const backups = readdirSync(backupsDir()).sort();
    expect(backups).toEqual([
      "v0.0.9-20260101T000000Z",
      expect.stringMatching(/^v0\.1\.0-\d{8}T\d{6}Z$/u),
    ]);
    expect(readFileSync(join(backupsDir(), backups[1]!, "postgres/marker"), "utf8")).toBe(
      "the owner's data\n",
    );
    // And beside the copy, the export any later version can load.
    expect(readFileSync(join(backupsDir(), backups[1]!, "export.jsonl.gz"), "utf8")).toBe(
      "everything Auni keeps\n",
    );
    expect(all()).toContain("Updated to Auni v0.1.1.");
    expect(all()).toContain(
      `Auni is running as a service again.\nOpen http://127.0.0.1:${port}\nRun auni stop to stop it.`,
    );
    // Its jobs were off, so a roll back would have undone nothing it sent; then it ran with them.
    expect(readFileSync(join(dataDir(), "started-with"), "utf8")).toBe(
      "--no-open --no-jobs\n--no-open\n",
    );
    expect(did).toEqual([
      asked,
      "stop service",
      "hold",
      "export",
      "release",
      "release",
      "start service",
    ]);
  });

  it("changes nothing when the database can't be exported first", async () => {
    version("v0.1.1", SERVES);
    const refused = update({
      version: "v0.1.1",
      host: host({ export: () => Promise.reject(new Error("the disk is full")) }),
    });
    await expect(refused).rejects.toThrow(
      /Couldn't export your database before updating \(the disk is full\)/u,
    );
    expect(currentTag()).toBe("v0.1.0");
    expect(marker()).toBe("the owner's data\n");
    // Held again once the service stopped, and let go of only to start the service again.
    expect(did).toEqual([asked, "stop service", "hold", "release", "start service"]);
  });

  it("stops an Auni a coding agent started in the background, and starts it there again", async () => {
    version("v0.1.1", SERVES);
    const background = host({ running: async () => runs("background") });
    expect(await update({ version: "v0.1.1", host: background })).toBe("updated");
    // Said before the owner is asked, so their yes is to stopping it too.
    const before = said.findIndex((line) => line.startsWith("Auni is running in the background."));
    expect(said[before]).toBe(
      "Auni is running in the background. It will finish any moves in progress, stop, and restart in the background once v0.1.1 is verified.",
    );
    expect(did).toEqual([
      "asked: Update from v0.1.0 to v0.1.1?",
      "stop background",
      "hold",
      "export",
      "release",
      "release",
      "start background",
    ]);
    expect(said.indexOf("Stopping Auni. Moves in progress will finish first.")).toBeGreaterThan(
      before,
    );
    // It answers again, on the new version, with its jobs on.
    expect(all()).toContain(
      `Auni is running in the background again.\nOpen http://127.0.0.1:${port}`,
    );
    expect(readFileSync(join(dataDir(), "started-with"), "utf8")).toBe(
      "--no-open --no-jobs\n--no-open\n",
    );
  });

  it("starts one that ran in a terminal again in the background, as no terminal waits for it", async () => {
    version("v0.1.1", SERVES);
    const terminal = host({ running: async () => runs("terminal") });
    expect(await update({ version: "v0.1.1", host: terminal })).toBe("updated");
    expect(all()).toContain(
      "Auni is running in a terminal. It will finish any moves in progress, stop, and restart in the background once v0.1.1 is verified.",
    );
    expect(did).toEqual([
      asked,
      "stop terminal",
      "hold",
      "export",
      "release",
      "release",
      "start background",
    ]);
    expect(all()).toContain(
      `Auni is running in the background now.\nOpen http://127.0.0.1:${port}`,
    );
  });

  it("leaves an Auni that wasn't running stopped, and says how to start it", async () => {
    version("v0.1.1", SERVES);
    expect(await update({ version: "v0.1.1", host: host({ running: async () => null }) })).toBe(
      "updated",
    );
    expect(did).toEqual([asked, "export", "release"]);
    expect(all()).toContain("Updated to Auni v0.1.1.\nRun auni to start it.");
  });

  it("changes nothing when Auni doesn't stop in time", async () => {
    version("v0.1.1", SERVES);
    const stuck = host({
      running: async () => runs("background"),
      stop: async () => false,
    });
    await expect(update({ version: "v0.1.1", host: stuck })).rejects.toThrow(
      "Auni didn't stop within 2.5 minutes, so nothing changed.",
    );
    expect(currentTag()).toBe("v0.1.0");
  });

  it("refuses to stop an Auni on another computer sharing this database, before asking", async () => {
    const elsewhere = host({ running: async () => ({ as: "background", pid: 4242, here: false }) });
    await expect(update({ version: "v0.1.1", host: elsewhere })).rejects.toThrow(
      "Auni is running on this database from another computer. Stop it there, then run auni update.",
    );
    expect(did).toEqual([]);
    expect(existsSync(versionDir("v0.1.1"))).toBe(false);
  });

  it("takes a source's version from the source, as install.sh would build it", async () => {
    version("v0.1.2", SERVES);
    vi.mocked(sourceTag).mockResolvedValue("v0.1.2");
    const source = host({ env: { ...host().env, AUNI_SOURCE: "/somewhere/auni.tar.gz" } });
    expect(await update({ host: source })).toBe("updated");
    expect(vi.mocked(sourceTag).mock.calls[0]![0].installer).toBe(
      join(versionDir("v0.1.0"), "install.sh"),
    );
    expect(vi.mocked(checkRelease)).not.toHaveBeenCalled();
    expect(all()).toContain("Update v0.1.0 -> v0.1.2 from the source you supplied (unsigned).");
    expect(currentTag()).toBe("v0.1.2");
  });

  it("says a source that is the version running is that version, and how to name another", async () => {
    vi.mocked(sourceTag).mockResolvedValue("v0.1.0");
    const source = host({ env: { ...host().env, AUNI_SOURCE: "/somewhere/auni.tar.gz" } });
    expect(await update({ host: source })).toBe("same");
    expect(all()).toContain(
      "Auni is already on v0.1.0. Pass --version <vX.Y.Z> to build this source under a different version.",
    );
  });

  it("refuses to copy a database that's still running, and starts the service again", async () => {
    version("v0.1.1", SERVES);
    const running = host();
    const refused = update({
      version: "v0.1.1",
      host: { ...running, postgres: { ...running.postgres!, running: async () => true } },
    });
    await expect(refused).rejects.toThrow("can't be copied safely. Nothing changed.");
    expect(currentTag()).toBe("v0.1.0");
    // Not even the export it began with is left.
    expect(readdirSync(backupsDir())).toEqual([]);
    expect(did).toEqual([
      asked,
      "stop service",
      "hold",
      "export",
      "release",
      "release",
      "start service",
    ]);
  });

  it("exports the owner's own database without copying its files, nor restores it on a roll back", async () => {
    version("v0.1.1", HANGS);
    expect(await update({ version: "v0.1.1", host: host({ postgres: null }) })).toBe("rolled-back");
    expect(all()).toContain("Your external database stays untouched. Only the export was saved.");
    // It is exported all the same, which is theirs to load back.
    expect(all()).toMatch(/Saved a database export to .*export\.jsonl\.gz/u);
    expect(all()).toContain(
      "v0.1.1 didn't start within 3 seconds, so Auni rolled back to v0.1.0. Your external database wasn't restored, and v0.1.1 may have changed it.",
    );
    expect(marker()).toContain("changed by the new version");
    // The export is all that was taken, and it is kept: the one way back to how things were.
    const [kept] = readdirSync(backupsDir());
    expect(readdirSync(join(backupsDir(), kept!))).toEqual(["export.jsonl.gz"]);
    expect(all()).toContain(`A pre-update backup is in ${backupsDir()}`);
  });

  it("builds the version with the installer the running one came with, and stays put when it fails", async () => {
    writeFileSync(
      join(versionDir("v0.1.0"), "install.sh"),
      'echo "building $AUNI_VERSION into $AUNI_HOME"\necho "npm is unreachable" >&2\nexit 1\n',
    );
    const refused = update({ version: "v0.1.1", host: host() });
    await expect(refused).rejects.toThrow(
      "v0.1.1 failed to build, so Auni stays on v0.1.0. See the build output above.",
    );
    expect(all()).toContain(`building v0.1.1 into ${dataDir()}`);
    expect(all()).toContain("npm is unreachable");
    expect(currentTag()).toBe("v0.1.0");
    expect(did).toEqual([asked]);
  });

  it("says what the release is and what changed, then changes nothing when the owner says no", async () => {
    version("v0.1.1", SERVES);
    const no = host({ confirm: async () => false });
    expect(await update({ host: no })).toBe("declined");
    expect(all()).toContain("Update v0.1.0 -> v0.1.1 (12 November 2026, signature verified)");
    expect(all()).toContain("Hyperliquid orders can be cancelled.");
    expect(all()).toContain("Nothing changed.");
    expect(currentTag()).toBe("v0.1.0");
    expect(did).toEqual([]);
  });

  it("asks this version's own installer to check the release, and passes on why it refused", async () => {
    vi.mocked(checkRelease).mockRejectedValue(
      new ReleaseRefused("Release v0.1.1 isn't signed by Auni's release key."),
    );
    const refused = update({ host: host() });
    await expect(refused).rejects.toThrow(UpdateRefused);
    await expect(refused).rejects.toThrow(
      "Release v0.1.1 isn't signed by Auni's release key. Auni stays on v0.1.0.",
    );
    expect(vi.mocked(checkRelease).mock.calls[0]![0].installer).toBe(
      join(versionDir("v0.1.0"), "install.sh"),
    );
    expect(existsSync(versionDir("v0.1.1"))).toBe(false);
    expect(did).toEqual([]);
  });

  it("says plainly when the version the owner named is older than the one running", async () => {
    version("v0.0.9", SERVES);
    expect(await update({ version: "v0.0.9", host: host() })).toBe("updated");
    expect(all()).toContain("Switch back v0.1.0 -> v0.0.9");
  });

  it("does nothing when that version is the one running", async () => {
    expect(await update({ version: "v0.1.0", host: host() })).toBe("same");
    expect(all()).toContain("Auni is already on v0.1.0.");
    expect(did).toEqual([]);
  });
});
