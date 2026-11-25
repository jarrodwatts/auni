import { z } from "zod";

import { NETWORK_KEYS } from "./networks.ts";

/** One connected browser session on this Auni (local pairing mode). */
export const ownerSessionWireSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
  current: z.boolean(),
  freshlyPaired: z.boolean(),
});
export type OwnerSessionWire = z.infer<typeof ownerSessionWireSchema>;

/** Live Tailscale state on this machine, as Settings -> Remote access shows it. */
export const tailscaleStateWireSchema = z.object({
  state: z.enum(["missing", "stopped", "tagged", "https_off", "ready"]),
  dnsName: z.string().nullable(),
  login: z.string().nullable(),
  /** Whether this Auni is currently configured for Tailscale owner auth (TAILSCALE_OWNER). */
  configured: z.boolean(),
  /** Whether `tailscale serve` currently points at Auni's door socket. */
  served: z.boolean(),
  /** Active or recommended free HTTPS port (443, or 8443+). */
  port: z.number().int().positive().nullable(),
  /** Full MagicDNS HTTPS URL once served or previewed. */
  url: z.string().nullable(),
  /** Plain-English explanation when Tailscale isn't ready yet. */
  problem: z.string().nullable(),
});
export type TailscaleStateWire = z.infer<typeof tailscaleStateWireSchema>;

/** Full Remote Access & Always-on status (`GET /system/remote`). */
export const remoteAccessWireSchema = z.object({
  mode: z.enum(["tailscale", "local"]),
  address: z.string(),
  machine: z.string(),
  ownerHere: z.boolean(),
  tailscale: tailscaleStateWireSchema,
  service: z.object({
    supported: z.boolean(),
    installed: z.boolean(),
    runningAs: z.enum(["service", "terminal", "background"]).nullable(),
    lingers: z.boolean().nullable(),
    lingerCommand: z.string().nullable(),
    staysOn: z.object({
      stays: z.boolean(),
      laptop: z.boolean(),
      says: z.string(),
    }),
  }),
  sessions: z.array(ownerSessionWireSchema),
});
export type RemoteAccessWire = z.infer<typeof remoteAccessWireSchema>;

export const tailscaleEnableRequestSchema = z.object({
  port: z.number().int().min(1).max(65_535).optional(),
});

const tailscaleStepWireSchema = z.object({
  step: z.string(),
  status: z.enum(["done", "note", "fix"]),
  says: z.string(),
  run: z.string().optional(),
});

export const tailscaleEnableResultSchema = z.object({
  ok: z.boolean(),
  url: z.string().nullable(),
  owner: z.string().nullable(),
  needsSudo: z.boolean(),
  sudoCommand: z.string().nullable(),
  needsRestart: z.boolean(),
  steps: z.array(tailscaleStepWireSchema),
});
export type TailscaleEnableResult = z.infer<typeof tailscaleEnableResultSchema>;

export const pairingMintWireSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  loopback: z.boolean(),
});
export type PairingMintWire = z.infer<typeof pairingMintWireSchema>;

/** Per-chain RPC state (`GET /system/rpcs`). Secret keys and full RPC URLs are never returned. */
export const rpcChainWireSchema = z.object({
  key: z.enum(NETWORK_KEYS),
  name: z.string(),
  source: z.enum(["own", "alchemy", "public"]),
  /** Hostname (and port) of a custom override when set; path, query, and credentials are stripped. */
  customHost: z.string().nullable(),
  /** Private field id to set/replace/clear this chain's custom RPC (`POST /private/:id`); null when env-locked. */
  field: z.string().nullable(),
  envVar: z.string(),
  /** True when set by the host shell environment rather than ~/.auni/.env. */
  envLocked: z.boolean(),
});
export type RpcChainWire = z.infer<typeof rpcChainWireSchema>;

export const rpcsWireSchema = z.object({
  alchemy: z.object({
    set: z.boolean(),
    source: z.enum(["environment", "file"]).nullable(),
    /** Private field id for Alchemy API key (`POST /private/:id`); null when env-locked. */
    field: z.string().nullable(),
  }),
  chains: z.array(rpcChainWireSchema),
  settingsFile: z.string(),
});
export type RpcsWire = z.infer<typeof rpcsWireSchema>;

/** Live `auni doctor` finding (`GET /system/diagnostics`). */
export const doctorFindingWireSchema = z.object({
  check: z.string(),
  status: z.enum(["ok", "note", "fix"]),
  says: z.string(),
  repair: z
    .object({
      id: z.string(),
      does: z.string(),
      recommended: z.boolean(),
    })
    .nullable(),
  /** The chat holding the card the finding is about (a held move's), where the owner acts on it. */
  thread: z.string().nullable(),
});
export type DoctorFindingWire = z.infer<typeof doctorFindingWireSchema>;

export const diagnosticsWireSchema = z.object({
  findings: z.array(doctorFindingWireSchema),
  ranAt: z.iso.datetime({ offset: true }),
});
export type DiagnosticsWire = z.infer<typeof diagnosticsWireSchema>;

export const repairRequestSchema = z.object({
  id: z.string().min(1).max(64),
});

export const repairResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  sudoCommand: z.string().nullable(),
  diagnostics: diagnosticsWireSchema,
});
export type RepairResult = z.infer<typeof repairResultSchema>;

export const logsWireSchema = z.object({
  path: z.string(),
  lines: z.array(z.string()),
});
export type LogsWire = z.infer<typeof logsWireSchema>;

export const aboutWireSchema = z.object({
  version: z.string(),
  checkout: z.boolean(),
  dataDir: z.string(),
  settingsFile: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  update: z.object({
    checked: z.boolean(),
    available: z.boolean(),
    latest: z.string().nullable(),
    note: z.string().nullable(),
  }),
});
export type AboutWire = z.infer<typeof aboutWireSchema>;
