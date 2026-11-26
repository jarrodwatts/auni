import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aboutWireSchema,
  logsWireSchema,
  rpcsWireSchema,
  startingPointsWireSchema,
} from "@auni/shared";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auniCapabilityTools } from "../agent/auni-tools.ts";
import { pair, sessionOf, signOutEverywhere } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { jobs, owner } from "../db/schema.ts";
import { env } from "../env.ts";
import { refreshOwnerSignals } from "../signals.ts";
import { setOwner, wipe } from "../test/db.ts";
import { serve } from "../test/serve.ts";
import { privateRouter } from "./private.ts";
import { startingPointsRouter } from "./starting-points.ts";
import { systemRouter } from "./system.ts";

const proof = vi.hoisted(() => ({ here: false }));
vi.mock("../auth/proof.ts", () => ({
  ownerHere: () => proof.here,
}));

const app = express()
  .use("/system", systemRouter)
  .use("/private", privateRouter)
  .use("/starting-points", startingPointsRouter);
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

describe("/system routes & network private fields", () => {
  it("refuses trust-boundary mutations without owner step-up proof", async () => {
    const endpoints: readonly [string, string, object][] = [
      ["POST", "/private/system%3Arpc%3Abase", { values: { url: "https://rpc.example.com" } }],
      ["POST", "/private/system%3Aalchemy", { values: { apiKey: "secret-alchemy-key" } }],
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

  it("saves Alchemy key and custom RPC URL via /private/:id and returns host-only status without secrets", async () => {
    proof.here = true;
    const SECRET_KEY = "alc_super_secret_key_999";

    const alchemyRes = await fetch(url("/private/system%3Aalchemy"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { apiKey: SECRET_KEY } }),
    });
    expect(alchemyRes.status).toBe(200);
    expect(await alchemyRes.text()).not.toContain(SECRET_KEY);

    const statusAfterAlchemy = await fetch(url("/system/rpcs"));
    const statusAlchemyText = await statusAfterAlchemy.text();
    expect(statusAlchemyText).not.toContain(SECRET_KEY);
    const afterAlchemy = rpcsWireSchema.parse(JSON.parse(statusAlchemyText));
    expect(afterAlchemy.alchemy).toEqual({ set: true, source: "file", field: "system:alchemy" });
    expect(afterAlchemy.chains.find((c) => c.key === "base")?.source).toBe("alchemy");

    const rpcRes = await fetch(url("/private/system%3Arpc%3Abase"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values: {
          url: "https://user:pass_secret@custom-base.example.com/v2/rpc_key_secret?token=query_secret",
        },
      }),
    });
    expect(rpcRes.status).toBe(200);

    const statusAfterRpc = await fetch(url("/system/rpcs"));
    const rpcText = await statusAfterRpc.text();
    expect(rpcText).not.toContain("pass_secret");
    expect(rpcText).not.toContain("rpc_key_secret");
    expect(rpcText).not.toContain("query_secret");
    const afterRpc = rpcsWireSchema.parse(JSON.parse(rpcText));
    const base = afterRpc.chains.find((c) => c.key === "base");
    expect(base?.source).toBe("own");
    expect(base?.customHost).toBe("custom-base.example.com");
    expect(base?.field).toBe("system:rpc:base");

    // Clear via /private/:id/clear restores Alchemy fallback.
    const clearRes = await fetch(url("/private/system%3Arpc%3Abase/clear"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "url" }),
    });
    expect(clearRes.status).toBe(200);
    const afterClear = rpcsWireSchema.parse(await (await fetch(url("/system/rpcs"))).json());
    expect(afterClear.chains.find((c) => c.key === "base")?.customHost).toBeNull();
  });

  it("redacts RPC URLs, core secrets, bearer tokens, pairing codes, API keys, and 64-hex keys from bounded GET /system/logs", async () => {
    const privKey = "a".repeat(64);
    env.ALCHEMY_API_KEY = "alchemy_live_secret_987654";
    writeFileSync(
      join(home, "auni.log"),
      [
        "normal boot line",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        "pairing link http://localhost:3000/app#pair=secretPairCode123",
        "provider key sk-ant-api03-verysecretvalue",
        "viem error URL: https://base-mainnet.g.alchemy.com/v2/rpc_path_secret_key?apikey=rpc_query_secret",
        "direct secret alchemy_live_secret_987654",
        `raw key 0x${privKey}`,
      ].join("\n"),
    );

    const res = await fetch(url("/system/logs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = logsWireSchema.parse(await res.json());
    const joined = body.lines.join("\n");
    expect(joined).toContain("normal boot line");
    expect(joined).toContain("base-mainnet.g.alchemy.com");
    expect(joined).not.toContain("eyJhbGci");
    expect(joined).not.toContain("secretPairCode123");
    expect(joined).not.toContain("verysecretvalue");
    expect(joined).not.toContain("rpc_path_secret_key");
    expect(joined).not.toContain("rpc_query_secret");
    expect(joined).not.toContain("alchemy_live_secret_987654");
    expect(joined).not.toContain(privKey);
  });

  it("returns version and local paths from GET /system/about", async () => {
    const res = await fetch(url("/system/about"));
    expect(res.status).toBe(200);
    const about = aboutWireSchema.parse(await res.json());
    expect(about.version).toMatch(/^v\d+/u);
    expect(about.dataDir.length).toBeGreaterThan(0);
  });

  it("browser-issued pairing links never grant step-up proof and are revoked by signOutEverywhere", async () => {
    proof.here = true;
    const res1 = await fetch(url("/system/sessions/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Phone" }),
    });
    expect(res1.status).toBe(200);
    const code1 = new URL(((await res1.json()) as { url: string }).url).hash.replace(
      /^#pair=/u,
      "",
    );
    const token = await pair(code1);
    expect(token).toBeTruthy();
    const session = await sessionOf(token!);
    expect(session).not.toBeNull();
    expect(session?.freshlyPaired).toBe(false);

    // Mint a second unused browser link, then sign out everywhere -> link becomes unusable too.
    const res2 = await fetch(url("/system/sessions/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Tablet" }),
    });
    const code2 = new URL(((await res2.json()) as { url: string }).url).hash.replace(
      /^#pair=/u,
      "",
    );
    await signOutEverywhere();
    expect(await sessionOf(token!)).toBeNull();
    expect(await pair(code2)).toBeNull();
  });
});

describe("refreshOwnerSignals disconnection handling", () => {
  it("clears auto-generated profileSummary when all sources are disconnected, but keeps manual notes", async () => {
    // Auto-generated summary matches generatedSummary -> cleared when no sources remain.
    await setOwner({
      xHandle: null,
      watchedWallets: [],
      profileSummary: "Auto generated summary from X.",
      profileSignals: {
        refreshedAt: new Date().toISOString(),
        xBio: "Old bio",
        xTopics: ["AI"],
        generatedSummary: "Auto generated summary from X.",
        watchedHoldings: [],
      },
    });
    await refreshOwnerSignals();
    let [row] = await db.select().from(owner);
    expect(row?.profileSignals).toBeNull();
    expect(row?.profileSummary).toBeNull();

    // Owner-edited summary differs from generatedSummary -> preserved when sources are removed.
    await setOwner({
      xHandle: null,
      watchedWallets: [],
      profileSummary: "My custom manual investing preferences.",
      profileSignals: {
        refreshedAt: new Date().toISOString(),
        xBio: "Old bio",
        xTopics: ["AI"],
        generatedSummary: "Auto generated summary from X.",
        watchedHoldings: [],
      },
    });
    await refreshOwnerSignals();
    [row] = await db.select().from(owner);
    expect(row?.profileSignals).toBeNull();
    expect(row?.profileSummary).toBe("My custom manual investing preferences.");
  });

  it("clears stale auto-generated summary when X is removed and a remaining watched wallet has no readable holdings", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline test rpc"));
    try {
      await setOwner({
        xHandle: null,
        watchedWallets: [
          { address: "0x000000000000000000000000000000000000dEaD", chain: "evm", label: "Empty" },
        ],
        profileSummary: "Old X-derived bio summary.",
        profileSignals: {
          refreshedAt: new Date().toISOString(),
          xBio: "Old bio",
          xTopics: ["AI"],
          generatedSummary: "Old X-derived bio summary.",
          watchedHoldings: [],
        },
      });
      await refreshOwnerSignals();
      const [row] = await db.select().from(owner);
      expect(row?.profileSignals?.generatedSummary).toBeNull();
      expect(row?.profileSummary).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("preserves existing X signals on transient failure for the same handle, but clears them after switching handles", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("transient outage"));
    try {
      await setOwner({
        xHandle: "alice",
        watchedWallets: [],
        profileSummary: "Follows AI infra and ETH.",
        profileSignals: {
          refreshedAt: new Date().toISOString(),
          xHandle: "alice",
          xBio: "Building AI infra",
          xTopics: ["AI infra", "Ethereum"],
          generatedSummary: "Follows AI infra and ETH.",
          watchedHoldings: [],
        },
      });
      await refreshOwnerSignals();
      let [row] = await db.select().from(owner);
      expect(row?.profileSignals?.xHandle).toBe("alice");
      expect(row?.profileSignals?.xBio).toBe("Building AI infra");
      expect(row?.profileSignals?.xTopics).toEqual(["AI infra", "Ethereum"]);
      expect(row?.profileSummary).toBe("Follows AI infra and ETH.");

      // Switching to a different handle must never reuse Alice's cached signals if the new handle fails.
      await setOwner({ xHandle: "bob" });
      await refreshOwnerSignals();
      [row] = await db.select().from(owner);
      expect(row?.profileSignals?.xHandle).toBe("bob");
      expect(row?.profileSignals?.xBio).toBeNull();
      expect(row?.profileSignals?.xTopics).toEqual([]);
      expect(row?.profileSummary).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("auniCapabilityTools", () => {
  it("inspect_auni exposes live config and structured health checks without leaking secrets or raw doctor text", async () => {
    env.ALCHEMY_API_KEY = "alc_never_leak_this_to_agent";
    const [inspect] = auniCapabilityTools();
    const out = await inspect!.handler({ include_health: true });
    const text = out.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("/app?settings=devices");
    expect(text).toContain("/app?settings=health");
    expect(text).not.toContain("alc_never_leak_this_to_agent");
    expect(text).not.toContain(env.TURN_TOKEN_SECRET);
    const structured = out.structuredContent as {
      health?: { checks?: { says?: unknown }[] };
    };
    expect(structured.health?.checks?.length ?? 0).toBeGreaterThan(0);
    for (const check of structured.health?.checks ?? []) {
      expect(check).not.toHaveProperty("says");
    }
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

  it("update_auni_preferences validates all fields before saving preferred_brain", async () => {
    delete process.env.BRAIN;
    const [, updatePrefs] = auniCapabilityTools();
    const out = await updatePrefs!.handler({
      preferred_brain: "codex",
      home_channel: "unpaired-channel",
    });
    expect(out.isError).toBe(true);
    expect(process.env.BRAIN).toBeUndefined();
  });

  it("update_auni_preferences refuses append_profile_note when it would exceed the 2,000-character limit", async () => {
    await setOwner({ profileSummary: "x".repeat(1_990) });
    const [, updatePrefs] = auniCapabilityTools();
    const out = await updatePrefs!.handler({
      append_profile_note: "This note cannot fit without truncation.",
    });
    expect(out.isError).toBe(true);
    const [row] = await db.select().from(owner);
    expect(row?.profileSummary).toBe("x".repeat(1_990));
  });

  it("tracks manual starting-points refreshes as pending on GET and deduplicates repeat clicks", async () => {
    await setOwner({
      startingPoints: [
        {
          statement: "Wallet is empty.",
          action: "Get started",
          prompt: "Help me fund my wallet.",
          image: null,
          sources: [{ app: "auni", label: "Your money", link: null }],
        },
      ],
      startingPointsAt: new Date(),
    });

    const before = startingPointsWireSchema.parse(
      await (await fetch(url("/starting-points"))).json(),
    );
    expect(before.pending).toBe(false);
    expect(before.points).toHaveLength(1);

    const r1 = await fetch(url("/starting-points/refresh"), { method: "POST" });
    const r2 = await fetch(url("/starting-points/refresh"), { method: "POST" });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const during = startingPointsWireSchema.parse(
      await (await fetch(url("/starting-points"))).json(),
    );
    expect(during.pending).toBe(true);
    expect(during.points).toEqual([]);

    const queued = (await db.select().from(jobs)).filter((j) => j.kind === "starting-points");
    expect(queued).toHaveLength(1);
  });
});
