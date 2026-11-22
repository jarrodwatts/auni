import {
  NETWORK_KEYS,
  NETWORKS,
  repairRequestSchema,
  tailscaleEnableRequestSchema,
  updateAlchemyRequestSchema,
  updateRpcRequestSchema,
  type AboutWire,
  type DiagnosticsWire,
  type LogsWire,
  type PairingMintWire,
  type RemoteAccessWire,
  type RepairResult,
  type RpcsWire,
} from "@auni/shared";
import express, { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  disableTailscaleFromUi,
  enableTailscaleFromUi,
  inspectTailscale,
  staysOn,
} from "../always-on.ts";
import {
  listSessions,
  mintPairingCode,
  PAIRING_TTL_MS,
  pairingLink,
  revokeOtherSessions,
  revokeSession,
} from "../auth/owner.ts";
import { ownerHere } from "../auth/proof.ts";
import { publishMe } from "../conversation/stream.ts";
import { auniLog, dataDir, settingsFile } from "../data-dir.ts";
import { doctor } from "../doctor.ts";
import { env, rpcUrlVar } from "../env.ts";
import { rpcFor } from "../money/chains.ts";
import { PrivateFieldRefused } from "../private-fields.ts";
import { checkRelease } from "../release/check.ts";
import { installed, runningVersion, versionDir } from "../release/layout.ts";
import { byRelease } from "../release/tags.ts";
import { isRepairId, repairDescription, runUiRepair } from "../repairs.ts";
import { runningAuni } from "../running.ts";
import { installService, lingers, serviceInstalled, uninstallService } from "../service.ts";
import { saveAlchemyKey, saveRpcUrl, setBy } from "../settings.ts";

/**
 * Local-first system controls behind `requireOwner`:
 * - Remote access (Tailscale HTTPS, background service, paired browser sessions & QR links)
 * - Chain RPCs & Alchemy API key
 * - Live `auni doctor` diagnostics, safe repairs, recent logs, and About/updates
 *
 * Every mutation that changes trust boundaries (Tailscale, service, pairing/sessions, RPCs,
 * Alchemy key, repairs) also requires owner step-up proof (`ownerHere(req)`).
 */
export const systemRouter = Router();
systemRouter.use(express.json({ limit: "16kb" }));

async function diagnosticsWire(): Promise<DiagnosticsWire> {
  const findings = await doctor();
  return {
    findings: findings.map((f) => ({
      check: f.check,
      status: f.status,
      says: f.says,
      repair: f.repair
        ? {
            id: f.repair.id,
            does: repairDescription(f.repair.id),
            recommended: f.repair.recommended,
          }
        : null,
    })),
    ranAt: new Date().toISOString(),
  };
}

/** Strips path, query string, and userinfo from a custom RPC URL so embedded API keys never leave core. */
function safeHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

function rpcsWire(): RpcsWire {
  const alchemySource = setBy("ALCHEMY_API_KEY");
  return {
    alchemy: { set: alchemySource !== null, source: alchemySource },
    chains: NETWORK_KEYS.map((key) => {
      const envVar = rpcUrlVar(key);
      const source = rpcFor(key).source;
      const customHost = safeHost(env.RPC_URLS[key]);
      return {
        key,
        name: NETWORKS[key].name,
        source,
        customHost,
        envVar,
        envLocked: setBy(envVar) === "environment",
      };
    }),
    settingsFile: settingsFile(),
  };
}

async function remoteWire(
  currentSessionId: string | undefined,
  proved: boolean,
): Promise<RemoteAccessWire> {
  const [tailscale, stays, running, sessions] = await Promise.all([
    inspectTailscale(),
    staysOn(),
    runningAuni().catch(() => null),
    env.TAILSCALE_OWNER ? Promise.resolve([]) : listSessions(currentSessionId),
  ]);
  const currentPlatform = platform();
  const lingerState = lingers();
  return {
    mode: env.TAILSCALE_OWNER ? "tailscale" : "local",
    address: env.WEB_ORIGIN,
    machine: hostname().split(".")[0]!,
    ownerHere: proved,
    tailscale,
    service: {
      supported: currentPlatform === "linux" || currentPlatform === "darwin",
      installed: serviceInstalled(),
      runningAs: running?.here ? running.as : null,
      lingers: lingerState,
      lingerCommand:
        currentPlatform === "linux" && lingerState !== true
          ? `sudo loginctl enable-linger ${userInfo().username}`
          : null,
      staysOn: { stays: stays.stays, laptop: stays.laptop, says: stays.says },
    },
    sessions,
  };
}

// --- Remote access, Tailscale, service & paired sessions ---

systemRouter.get("/remote", async (req, res) => {
  res.json(await remoteWire(req.sessionId, ownerHere(req)));
});

systemRouter.post("/tailscale/enable", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const parsed = tailscaleEnableRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success)
    return void res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  const result = await enableTailscaleFromUi(parsed.data.port ?? null);
  publishMe();
  res.json(result);
});

systemRouter.post("/tailscale/disable", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const result = await disableTailscaleFromUi();
  publishMe();
  res.json(result);
});

systemRouter.post("/service/install", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  try {
    const message = installService();
    publishMe();
    res.json({ ok: true, message, remote: await remoteWire(req.sessionId, true) });
  } catch (error) {
    res.status(400).json({
      error: "service_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

systemRouter.post("/service/uninstall", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  try {
    uninstallService();
    publishMe();
    res.json({ ok: true, remote: await remoteWire(req.sessionId, true) });
  } catch (error) {
    res.status(400).json({
      error: "service_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

const mintBody = z.object({ label: z.string().trim().max(64).optional() });

systemRouter.post("/sessions/pair", async (req, res) => {
  if (env.TAILSCALE_OWNER) return void res.status(409).json({ error: "pairing_off" });
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const parsed = mintBody.safeParse(req.body ?? {});
  const code = await mintPairingCode(parsed.success ? parsed.data.label : undefined);
  const url = pairingLink(code);
  const host = new URL(url).hostname;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  res.setHeader("Cache-Control", "no-store");
  res.json({
    url,
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    loopback,
  } satisfies PairingMintWire);
});

systemRouter.delete("/sessions/:id", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) return void res.status(400).json({ error: "invalid_session_id" });
  const removed = await revokeSession(id.data, req.sessionId);
  if (!removed) return void res.status(409).json({ error: "cannot_revoke_session" });
  res.json(await remoteWire(req.sessionId, true));
});

systemRouter.post("/sessions/revoke-others", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const revoked = await revokeOtherSessions(req.sessionId);
  res.json({ revoked, remote: await remoteWire(req.sessionId, true) });
});

// --- Network & RPCs ---

systemRouter.get("/rpcs", (_req, res) => {
  res.json(rpcsWire());
});

systemRouter.put("/rpcs", (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const parsed = updateRpcRequestSchema.safeParse(req.body);
  if (!parsed.success)
    return void res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  try {
    saveRpcUrl(parsed.data.chain, parsed.data.url);
    res.json(rpcsWire());
  } catch (error) {
    if (error instanceof PrivateFieldRefused)
      return void res.status(400).json({ error: "invalid_rpc", detail: error.message });
    throw error;
  }
});

systemRouter.put("/alchemy", (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const parsed = updateAlchemyRequestSchema.safeParse(req.body);
  if (!parsed.success)
    return void res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  try {
    saveAlchemyKey(parsed.data.apiKey);
    res.json(rpcsWire());
  } catch (error) {
    if (error instanceof PrivateFieldRefused)
      return void res.status(400).json({ error: "invalid_key", detail: error.message });
    throw error;
  }
});

// --- Diagnostics, logs & About ---

systemRouter.get("/diagnostics", async (_req, res) => {
  res.json(await diagnosticsWire());
});

systemRouter.post("/diagnostics/repair", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const parsed = repairRequestSchema.safeParse(req.body);
  if (!parsed.success || !isRepairId(parsed.data.id))
    return void res.status(400).json({ error: "unknown_repair" });
  const outcome = await runUiRepair(parsed.data.id);
  publishMe();
  res.json({
    ...outcome,
    diagnostics: await diagnosticsWire(),
  } satisfies RepairResult);
});

const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu,
  /(#pair=)[A-Za-z0-9_-]{8,}/giu,
  /(sk-[A-Za-z0-9_-]{12,})/gu,
  /([0-9a-f]{64})/giu,
];

function redactLogLine(line: string): string {
  let out = line;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && prefix !== match ? `${prefix}[redacted]` : "[redacted]",
    );
  }
  return out;
}

systemRouter.get("/logs", (_req, res) => {
  const path = auniLog();
  let lines: string[] = [];
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf8");
      lines = content
        .split("\n")
        .filter((line) => line.length > 0)
        .slice(-200)
        .map(redactLogLine);
    } catch {
      lines = [];
    }
  }
  res.json({ path, lines } satisfies LogsWire);
});

systemRouter.get("/about", async (req, res) => {
  const version = `v${runningVersion()}`;
  const checkout = !installed();
  const checkRequested = req.query.check === "1";
  let update: AboutWire["update"] = {
    checked: false,
    available: false,
    latest: null,
    note: checkout ? "Running from a source checkout (pull main to update)." : null,
  };
  if (checkRequested && !checkout) {
    try {
      const newest = await checkRelease({
        installer: join(versionDir(version), "install.sh"),
        env: process.env,
      });
      const available = byRelease(newest.version, version) > 0;
      update = {
        checked: true,
        available,
        latest: newest.version,
        note: available
          ? `${newest.version} is available. Run \`auni update\` in your terminal to upgrade.`
          : "You're on the latest release.",
      };
    } catch (error) {
      update = {
        checked: true,
        available: false,
        latest: null,
        note: `Couldn't check for updates: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  res.json({
    version,
    checkout,
    dataDir: dataDir(),
    settingsFile: settingsFile(),
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    update,
  } satisfies AboutWire);
});
