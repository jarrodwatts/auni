import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "./test/temp-dir.ts";
import { doctor } from "./doctor.ts";
import { agentEnv, prepareTriage } from "./triage.ts";

vi.mock("./doctor.ts", () => ({ doctor: vi.fn() }));
// No service on the machine running the tests is read: its journal is this machine's own.
vi.mock("./service.ts", () => ({
  serviceInstalled: () => false,
  serviceOutput: () => "journalctl --user -u auni -n 100 --no-pager",
}));

/** A data folder as a running Auni leaves it: its settings, secrets, keys, database and output. */
function dataFolder(): string {
  const data = tempDir("auni-triage-");
  vi.stubEnv("AUNI_HOME", data);
  writeFileSync(
    join(data, ".env"),
    "TELEGRAM_BOT_TOKEN=123456789:telegramsecrettoken\nBRAIN=codex\n",
  );
  writeFileSync(join(data, "turn-token-secret"), "a".repeat(64));
  writeFileSync(join(data, "wallet-keys.json"), "{}");
  mkdirSync(join(data, "postgres"));
  mkdirSync(join(data, "run"));
  writeFileSync(
    join(data, "auni.log"),
    "Telegram said 401 for token 123456789:telegramsecrettoken\nAuni is ready\n",
  );
  return data;
}

beforeEach(() => {
  vi.mocked(doctor).mockResolvedValue([{ check: "runner", status: "ok", says: "running" }]);
});
afterEach(() => vi.unstubAllEnvs());

describe("auni triage", () => {
  it("hands the agent the owner's shell, less every setting of Auni's", () => {
    dataFolder();
    const shell = {
      PATH: "/usr/bin",
      HOME: "/home/me",
      EDITOR: "vim",
      // In the settings file, an app's own, core's secrets, and an RPC with its key in its path.
      BRAIN: "codex",
      TELEGRAM_BOT_TOKEN: "123456789:telegramsecrettoken",
      AUNI_ANTHROPIC_API_KEY: "sk-ant-secret",
      DATABASE_URL: "postgres://auni:password@localhost/auni",
      TURN_TOKEN_SECRET: "a".repeat(64),
      ALCHEMY_API_KEY: "alchemy-secret",
      RPC_URL_MONAD: "https://rpc.example/key",
    };
    expect(agentEnv(shell)).toEqual({ PATH: "/usr/bin", HOME: "/home/me", EDITOR: "vim" });
  });

  it("writes the playbook, the facts, doctor's findings and the output, and hides the rest of the data folder", async () => {
    const data = dataFolder();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456789:telegramsecrettoken");
    const triage = await prepareTriage();
    expect(triage.folder.startsWith(join(data, "triage/"))).toBe(true);
    const read = (name: string) => readFileSync(join(triage.folder, name), "utf8");

    expect(JSON.parse(read("doctor.json"))).toEqual([
      { check: "runner", status: "ok", says: "running" },
    ]);
    // Auni's output, with a secret a service echoed blanked.
    expect(read("output.txt")).toContain("Telegram said 401 for token …\nAuni is ready");
    expect(read("output.txt")).not.toContain("telegramsecrettoken");

    // Everything but Auni's output, its triage folders and an install's source (and any .env
    // the clone running this keeps beside its code).
    expect(triage.hidden.filter((path) => path.startsWith(data)).sort()).toEqual(
      [".env", "postgres", "run", "turn-token-secret", "wallet-keys.json"].map((name) =>
        join(data, name),
      ),
    );
    const context = read("context.md");
    for (const path of triage.hidden) expect(context).toContain(`- ${path}\n`);
    expect(context).toContain(
      `Auni's latest output, each secret Auni holds blanked: ${join(triage.folder, "output.txt")}`,
    );

    const playbook = read("TRIAGE.md");
    expect(triage.playbook).toBe(join(triage.folder, "TRIAGE.md"));
    expect(playbook).toContain(join(triage.folder, "context.md"));
    expect(playbook).toContain("# Auni triage playbook");
    // What the agent is told it never reads, never does, and asks first.
    expect(playbook).toMatch(/\*\*Never read a secret\.\*\*/u);
    expect(playbook).toMatch(/Never run `auni pair`/u);
    expect(playbook).toMatch(/\*\*Ask before you change anything\.\*\*/u);
    expect(playbook).toMatch(/Never fill `transaction`/u);
  });
});
