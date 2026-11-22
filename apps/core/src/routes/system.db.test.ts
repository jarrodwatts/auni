import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aboutWireSchema, logsWireSchema, rpcsWireSchema } from "@auni/shared";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auniCapabilityTools } from "../agent/auni-tools.ts";
import { db } from "../db/client.ts";
import { jobs, owner } from "../db/schema.ts";
import { env } from "../env.ts";
import { wipe } from "../test/db.ts";
import { serve } from "../test/serve.ts";
import { systemRouter } from "./system.ts";

const proof = vi.hoisted(() => ({ here: false }));
vi.mock("../auth/proof.ts", () => ({
  ownerHere: () => proof.here,
}));

const app = express().use("/system", systemRouter);
const url = serve(app);

let home: string;
const prevHome = process.env.AUNI_HOME;

beforeEach(async () => {
  await wipe();
  proof.here = false;
  home = mkdtempSync(join(tmpdir(), "auni-system-test-"));
  process.env.AUNI_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.AUNI_HOME;
  else process.env.AUNI_HOME = prevHome;
  delete process.env.RPC_URL_BASE;
  delete process.env.ALCHEMY_API_KEY;
  env.RPC_URLS = {};
  env.ALCHEMY_API_KEY = undefined;
});

describe("/system routes", () => {
  it("refuses trust-boundary mutations without owner step-up proof", async () => {
    const endpoints: readonly [string, string, object][] = [
      ["PUT", "/system/rpcs", { chain: "base", url: "https://rpc.example.com" }],
      ["PUT", "/system/alchemy", { apiKey: "secret-alchemy-key" }],
      ["POST", "/system/tailscale/enable", { port: 443 }],
      ["POST", "/system/sessions/pair", {}],
      ["POST", "/system/diagnostics/repair", { id: "install-service" }],
    ];
    for (const [method, path, body] of endpoints) {
      const res = await fetch(url(path), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: "pair_again" });
    }
  });

  it("saves custom RPCs and Alchemy key with step-up proof and never returns the key", async () => {
    proof.here = true;
    const SECRET_KEY = "alc_super_secret_key_999";

    const alchemyRes = await fetch(url("/system/alchemy"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: SECRET_KEY }),
    });
    expect(alchemyRes.status).toBe(200);
    const alchemyText = await alchemyRes.text();
    expect(alchemyText).not.toContain(SECRET_KEY);
    const afterAlchemy = rpcsWireSchema.parse(JSON.parse(alchemyText));
    expect(afterAlchemy.alchemy).toEqual({ set: true, source: "file" });
    expect(afterAlchemy.chains.find((c) => c.key === "base")?.source).toBe("alchemy");

    const rpcRes = await fetch(url("/system/rpcs"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: "base", url: "https://custom-base.example.com/" }),
    });
    expect(rpcRes.status).toBe(200);
    const afterRpc = rpcsWireSchema.parse(await rpcRes.json());
    const base = afterRpc.chains.find((c) => c.key === "base");
    expect(base?.source).toBe("own");
    expect(base?.customUrl).toBe("https://custom-base.example.com");
  });

  it("redacts bearer tokens, pairing codes, API keys, and 64-hex keys from GET /system/logs", async () => {
    const privKey = "a".repeat(64);
    writeFileSync(
      join(home, "auni.log"),
      [
        "normal boot line",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        "pairing link http://localhost:3000/app#pair=secretPairCode123",
        "provider key sk-ant-api03-verysecretvalue",
        `raw key 0x${privKey}`,
      ].join("\n"),
    );

    const res = await fetch(url("/system/logs"));
    expect(res.status).toBe(200);
    const body = logsWireSchema.parse(await res.json());
    const joined = body.lines.join("\n");
    expect(joined).toContain("normal boot line");
    expect(joined).not.toContain("eyJhbGci");
    expect(joined).not.toContain("secretPairCode123");
    expect(joined).not.toContain("verysecretvalue");
    expect(joined).not.toContain(privKey);
  });

  it("returns version and local paths from GET /system/about", async () => {
    const res = await fetch(url("/system/about"));
    expect(res.status).toBe(200);
    const about = aboutWireSchema.parse(await res.json());
    expect(about.version).toMatch(/^v\d+/u);
    expect(about.dataDir.length).toBeGreaterThan(0);
  });
});

describe("auniCapabilityTools", () => {
  it("inspect_auni exposes live config and settings links without leaking secrets", async () => {
    env.ALCHEMY_API_KEY = "alc_never_leak_this_to_agent";
    const [inspect] = auniCapabilityTools();
    const out = await inspect!.handler({ include_health: false });
    const text = out.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("/app?settings=remote");
    expect(text).toContain("/app?settings=diagnostics");
    expect(text).not.toContain("alc_never_leak_this_to_agent");
    expect(text).not.toContain(env.TURN_TOKEN_SECRET);
  });

  it("update_auni_preferences persists safe prefs and queues signals refresh atomically", async () => {
    const [, updatePrefs] = auniCapabilityTools();
    const out = await updatePrefs!.handler({
      name: "Jarrod",
      look: "dark",
      x_handle: "@jarrod_watts",
      add_watched_wallet: {
        address: "0x000000000000000000000000000000000000dEaD",
        label: "Main",
      },
      append_profile_note: "Prefers spot over high leverage.",
    });
    expect(out.isError).toBeUndefined();

    const [row] = await db.select().from(owner);
    expect(row?.name).toBe("Jarrod");
    expect(row?.look).toBe("dark");
    expect(row?.xHandle).toBe("jarrod_watts");
    expect(row?.watchedWallets).toHaveLength(1);
    expect(row?.watchedWallets[0]?.label).toBe("Main");
    expect(row?.profileSummary).toContain("Prefers spot over high leverage.");

    const queued = await db.select().from(jobs);
    expect(queued.some((j) => j.kind === "signals")).toBe(true);
  });
});
