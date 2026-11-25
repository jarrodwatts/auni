import { NETWORKS, type EvmChainKey } from "@auni/shared";
import postgres from "postgres";
import { InvalidParamsRpcError } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { brainRows } from "./agent/brain.ts";
import { db } from "./db/client.ts";
import { appTroubles, jobs } from "./db/schema.ts";
import { doctor, doctorSummary, line, type Finding } from "./doctor.ts";
import { env } from "./env.ts";
import * as migrations from "./db/migrations.ts";
import { checkRelease } from "./release/check.ts";
import { runningVersion, versionLine } from "./release/layout.ts";
import { holderName } from "./running.ts";
import { ownCommand } from "./service.ts";
import { wipe } from "./test/db.ts";

vi.mock("./agent/brain.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  brainRows: vi.fn(),
}));
vi.mock("./money/chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publicClient: (chain: EvmChainKey) => chains(chain),
  eachRpc: (chain: EvmChainKey) => [{ url: `https://${chain}.example`, client: chains(chain) }],
  solanaRpc: async () => 1,
}));
// Whether this runs as an installed version, rather than from the checkout it does run from.
const layout = vi.hoisted(() => ({ installed: false }));
vi.mock("./release/layout.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  installed: () => layout.installed,
}));
vi.mock("./release/check.ts", () => ({ checkRelease: vi.fn() }));
// How this machine reaches the owner reads Tailscale itself: always-on.ts's own business.
vi.mock("./always-on.ts", () => ({ reachFindings: async () => [] }));
// The service this machine has installed, by the command it runs, and whether it starts at boot:
// none, unless a test installs one.
const service = vi.hoisted(() => ({
  command: null as string[] | null,
  lingers: null as boolean | null,
}));
vi.mock("./service.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  serviceInstalled: () => service.command !== null,
  serviceCommand: () => service.command,
  lingers: () => service.lingers,
}));
// Whether the stand-in wallet has been made yet.
const wallet = vi.hoisted(() => ({ made: false }));
vi.mock("./apps/registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./apps/registry.ts")>();
  return {
    ...real,
    walletApp: () => ({
      about: { ...real.walletApp().about },
      provided: {
        addresses: async () =>
          wallet.made ? { evm: "0xabc", solana: null } : { evm: null, solana: null },
        keptHere: {
          where: async () =>
            wallet.made
              ? { place: 'in the OS keychain, as "wallet-keys:/me/.auni" under "auni"' }
              : null,
        },
      },
    }),
  };
});

/**
 * Each chain answers everything, but Monad lists no logs, Base keeps no past balances and
 * Polygon's RPC is too busy to read one.
 */
function chains(chain: EvmChainKey) {
  const refused = (why: string) => () => Promise.reject(new InvalidParamsRpcError(new Error(why)));
  return {
    getBlockNumber: async () => 10_000n,
    request: chain === "monad" ? refused("not here") : async () => [],
    getBalance:
      chain === "base"
        ? refused("missing trie node")
        : chain === "polygon"
          ? refused("request limit reached")
          : async () => 0n,
  };
}

const version = runningVersion();
const of = (findings: readonly Finding[], check: Finding["check"]) =>
  findings.filter((finding) => finding.check === check).map(line);

beforeEach(async () => {
  await wipe(jobs, appTroubles);
  wallet.made = false;
  layout.installed = false;
  service.command = null;
  service.lingers = null;
  vi.mocked(brainRows).mockResolvedValue([
    { id: "claude-code", name: "Claude Code", state: "signed-out", fix: "claude auth login" },
    { id: "codex", name: "Codex", state: "not-installed", fix: "npm install -g @openai/codex" },
  ]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
});
afterEach(() => vi.restoreAllMocks());

describe("auni doctor", () => {
  it("says what works and what to fix, naming the setting that fixes a chain", async () => {
    const findings = await doctor();
    expect(of(findings, "version")).toEqual([`ok   version: v${version}, from a source checkout`]);
    expect(of(findings, "database")).toEqual(["ok   database: connects, at this version's schema"]);
    expect(of(findings, "runner")).toEqual([
      "fix  runner: Auni isn't running: start it with `auni`, or keep it running with `auni service install`",
    ]);
    const rpc = of(findings, "rpc");
    expect(rpc).toHaveLength(Object.keys(NETWORKS).length);
    expect(rpc).toContainEqual(
      expect.stringMatching(
        /^fix {2}rpc: Monad won't list 1,000 blocks of logs.*set RPC_URL_MONAD/u,
      ),
    );
    expect(rpc).toContainEqual(expect.stringMatching(/^note rpc: Base, .*keeps no past balances/u));
    expect(rpc).toContainEqual(
      expect.stringMatching(/^fix {2}rpc: Polygon won't read past balances.*set RPC_URL_POLYGON/u),
    );
    expect(rpc).toContainEqual(expect.stringMatching(/^ok {3}rpc: Arbitrum, through/u));
    expect(of(findings, "brain")).toEqual([
      "note brain: Auni asks Claude Code, then Codex, and thinks with the first that is ready. You can also pick a model right in any thread.",
      // Each made ready from the web app, on any device; the command stays for this machine.
      "fix  brain: Claude Code: sign it in from Settings → AI Brains, on any of your devices (or run `claude auth login` where Auni runs)",
      "fix  brain: Codex: install it from Settings → AI Brains, on any of your devices (or run `npm install -g @openai/codex` where Auni runs)",
    ]);
    expect(of(findings, "wallet")).toEqual([
      expect.stringMatching(/^ok {3}wallet: .*no wallet yet: the owner makes or brings one/u),
    ]);
    expect(of(findings, "apps")).toEqual(["ok   apps: nothing has kept failing"]);
    expect(of(findings, "web")).toEqual([`ok   web: ${env.WEB_ORIGIN} answers and reaches core`]);
  });

  it("leads with startup when updates are pending, while keeping independent network checks", async () => {
    vi.spyOn(migrations, "pendingMigrations").mockResolvedValue(1);
    vi.mocked(fetch).mockRejectedValue(new Error("fetch failed"));

    const findings = await doctor();
    expect(doctorSummary(findings, "pnpm auni")).toBe(
      [
        "Auni is stopped.",
        "Run pnpm auni",
        "Needs attention: Your AI",
        "Waiting for startup: Web app, Wallet, Apps",
        "Networks: 7 chains ready, 1 with limits, check Monad, Polygon",
        "Passed: Version",
        "Every check: pnpm auni doctor --verbose",
      ].join("\n"),
    );
    // Machine readers still see the individual findings and no presentation fields.
    expect(JSON.parse(JSON.stringify(findings))).toContainEqual({
      check: "database",
      status: "fix",
      says: "1 migrations to apply: `auni` applies them as it starts",
    });
    expect(of(findings, "web")).toContainEqual(expect.stringMatching(/fetch failed/u));
    expect(of(findings, "wallet")).toEqual(["fix  wallet: needs the database first"]);
  });

  it("keeps database failures visible when starting won't resolve them", () => {
    const summary = doctorSummary(
      [
        { check: "database", status: "fix", says: "can't connect" },
        { check: "runner", status: "fix", says: "needs the database first" },
        { check: "web", status: "fix", says: "nothing answers" },
      ],
      "auni",
    );
    expect(summary).toMatch(/^Auni can't check its database\.\nRun auni doctor --verbose/u);
    expect(summary).not.toContain("Background work");
    expect(summary).not.toContain("Web app");
  });

  it("shows recent failed tasks without the error in the default summary", async () => {
    const auni = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
    await auni`select pg_advisory_lock(hashtext('auni:runner'))`;
    try {
      await db.insert(jobs).values([
        { kind: "found", data: {}, finishedAt: new Date(), outcome: "failed", error: "no price" },
        { kind: "reading", data: {}, finishedAt: new Date(), outcome: "failed", error: "RPC busy" },
      ]);
      const findings = await doctor();
      expect(of(findings, "runner")).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/no price/u),
          expect.stringMatching(/RPC busy/u),
        ]),
      );
      const summary = doctorSummary(findings, "auni");
      expect(summary).toContain("Background work: 2 tasks failed in the last 24 hours.");
      expect(summary).not.toMatch(/no price|RPC busy/u);
    } finally {
      await auni.end();
    }
  });

  it("doesn't count local-only access as working remote access", () => {
    const summary = doctorSummary(
      [
        { check: "runner", status: "ok", says: "running" },
        { check: "always-on", status: "note", says: "on this computer only" },
        { check: "always-on", status: "ok", says: "stays awake" },
      ],
      "auni",
    );
    expect(summary).toContain("Access: this computer only.");
    expect(summary).toContain("Passed: Background work\n");
    expect(summary).not.toContain("Access from other devices");
  });

  it("says what keeps going wrong for an app, the oldest first: a read a service retired, a key out of credits", async () => {
    const lastAt = new Date("2026-11-13T09:40:00Z");
    await db.insert(appTroubles).values([
      {
        app: "elfa",
        work: "looking things up",
        kind: "credits",
        said: "Elfa is out of credits",
        lastAt,
      },
      {
        app: "polymarket",
        work: "reading payouts",
        kind: "failing",
        said: 'Polymarket data API answered HTTP 410: {"error":"Data API v1 has been retired"}',
        since: lastAt,
        times: 12,
      },
    ]);
    expect(of(await doctor(), "apps")).toEqual([
      `fix  apps: Polymarket, not working: Reading payouts failed 12 times since ${lastAt.toLocaleString()}: Polymarket data API answered HTTP 410: {"error":"Data API v1 has been retired"}`,
      `fix  apps: Elfa, out of credits: Elfa said its account is out of credits when Auni last asked it, at ${lastAt.toLocaleString()}. Auni can't use Elfa until the account is topped up, and starts again by itself once it is.`,
    ]);
  });

  it("names the brain that thinks, and the others as notes", async () => {
    vi.mocked(brainRows).mockResolvedValue([
      {
        id: "claude-code",
        name: "Claude Code",
        state: "ready",
        login: "your Claude Max plan",
        models: [],
      },
      { id: "codex", name: "Codex", state: "expired", fix: "codex login --device-auth" },
    ]);
    // The rule that picks between them comes first, in one sentence.
    expect(of(await doctor(), "brain")).toEqual([
      expect.stringMatching(
        /^note brain: Auni asks Claude Code, then Codex, and thinks with the first that is ready\. You can also pick a model right in any thread\.$/u,
      ),
      "ok   brain: Claude Code, on your Claude Max plan",
      "note brain: Codex's sign-in has expired: sign it in from Settings → AI Brains, on any of your devices (or run `codex login --device-auth` where Auni runs)",
    ]);
  });

  it("checks a running Auni's jobs, the owner's addresses and where their keys are", async () => {
    wallet.made = true;
    // Another process holds the runner's lock, as a running Auni does.
    const auni = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
    await auni`select pg_advisory_lock(hashtext('auni:runner'))`;
    try {
      await db.insert(jobs).values([
        { kind: "reading", data: {}, runAt: new Date(Date.now() - 10 * 60_000) },
        { kind: "found", data: {}, finishedAt: new Date(), outcome: "failed", error: "no price" },
      ]);
      const findings = await doctor();
      expect(of(findings, "runner")).toEqual([
        "fix  runner: 1 jobs are over 5 minutes late: Auni's output says what holds them up",
        "note runner: 1 found jobs failed in the last day, the latest: no price",
      ]);
      expect(of(findings, "wallet")).toEqual([
        expect.stringMatching(
          /^ok {3}wallet: .*EVM 0xabc, its keys in the OS keychain, as "wallet-keys:\/me\/.auni" under "auni"$/u,
        ),
      ]);
    } finally {
      await auni.end();
    }
  });

  it("says whether an install is the newest version, or which one is out", async () => {
    layout.installed = true;
    const out = (newest: string) =>
      vi.mocked(checkRelease).mockResolvedValue({
        version: newest,
        made: "2026-11-12T10:00:00Z",
        commit: "691dcde58",
        source: "0".repeat(64),
        notes: "",
      });
    out(`v${version}`);
    expect(of(await doctor(), "version")).toEqual([`ok   version: v${version}, the newest`]);
    out("v99.0.0");
    expect(of(await doctor(), "version")).toEqual([
      `note version: v${version}; v99.0.0 is out: auni update`,
    ]);
    // A release no key it lists signed is never "out": the installer's own words say why.
    vi.mocked(checkRelease).mockRejectedValue(
      new Error("Release v99.0.0 isn't signed by Auni's release key."),
    );
    expect(of(await doctor(), "version")).toEqual([
      `note version: v${version} (couldn't check for a newer one: Release v99.0.0 isn't signed by Auni's release key.)`,
    ]);
  });

  /** Each finding of `check` with the repair it offers, as `auni doctor --json` says it. */
  const repairs = (findings: readonly Finding[], check: Finding["check"]) =>
    findings
      .filter((finding) => finding.check === check)
      .map(({ status, says, repair }) => ({ status, says, repair }));

  it("offers to start an installed service, and to install one only when asked", async () => {
    expect(repairs(await doctor(), "runner")).toEqual([
      expect.objectContaining({ repair: { id: "install-service", recommended: false } }),
    ]);
    service.command = ownCommand();
    service.lingers = true;
    const findings = await doctor();
    expect(repairs(findings, "runner")).toEqual([
      {
        status: "fix",
        says: "Auni isn't running, though its service is installed",
        repair: { id: "start-service", recommended: true },
      },
    ]);
    expect(of(findings, "service")).toEqual(["ok   service: installed, and starts by itself"]);
  });

  // `auni up --always-on` installs the service: always on, the owner chose how Auni runs.
  it("always on, installs the service unasked", async () => {
    const mode = env as { TAILSCALE_OWNER?: string };
    mode.TAILSCALE_OWNER = "owner@example.com";
    try {
      expect(repairs(await doctor(), "runner")).toEqual([
        expect.objectContaining({ repair: { id: "install-service", recommended: true } }),
      ]);
    } finally {
      delete mode.TAILSCALE_OWNER;
    }
  });

  it("offers to write a service whose command is gone, and to start it at boot", async () => {
    service.command = ["/gone/node/v20/bin/node", "/home/me/auni/apps/core/bin/auni.mjs"];
    expect(repairs(await doctor(), "service")).toEqual([
      {
        status: "fix",
        says: "it runs /gone/node/v20/bin/node, which is gone, so it can't start: `auni service install` writes it again",
        repair: { id: "rewrite-service", recommended: true },
      },
    ]);
    service.command = ownCommand();
    service.lingers = false;
    expect(repairs(await doctor(), "service")).toEqual([
      {
        status: "fix",
        says: "Auni stops when you log out, and starts again only when you log in",
        repair: { id: "linger", recommended: true },
      },
    ]);
  });

  it("offers to restart a service running older code than its folder holds", async () => {
    // The service holds the runner's lock, named as the service's own process names it.
    vi.stubEnv("AUNI_RUNS_AS", "service");
    const auni = postgres(env.DATABASE_URL, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: holderName() },
    });
    await auni`select pg_advisory_lock(hashtext('auni:runner'))`;
    const answers = (version: string) =>
      vi
        .mocked(fetch)
        .mockImplementation(async () => new Response(JSON.stringify({ status: "ok", version })));
    try {
      service.command = ownCommand();
      answers(versionLine());
      expect(of(await doctor(), "runner")).toEqual([
        expect.stringMatching(/^ok {3}runner: running as a service, nothing late$/u),
      ]);
      answers("0.0.9 (0ld0ld0ld)");
      expect(repairs(await doctor(), "runner")).toEqual([
        {
          status: "fix",
          says: `Auni's service runs 0.0.9 (0ld0ld0ld), and its folder now holds ${versionLine()}`,
          repair: { id: "restart-service", recommended: true },
        },
      ]);
      // A service from another folder: restarting it would run the same old code.
      service.command = ["/elsewhere/node", "/elsewhere/auni.mjs", "--no-open"];
      const findings = await doctor();
      expect(doctorSummary(findings, "pnpm auni")).toContain(
        "Stop Auni, then start it from this folder to use this version.",
      );
      expect(repairs(findings, "runner")).toEqual([
        {
          status: "note",
          says: `Auni runs 0.0.9 (0ld0ld0ld) as a service, and this folder holds ${versionLine()}: restart it to run this one`,
          repair: undefined,
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      await auni.end();
    }
  });
});
