import { NETWORK_KEYS, type NetworkKey } from "@auni/shared";
import { z } from "zod";

// Kept without a trailing slash, so every path joins on with exactly one.
const baseUrlSchema = z
  .string()
  .url()
  .transform((url) => url.replace(/\/+$/u, ""));

// Core's own settings, parsed once at import time, so a missing or invalid var fails boot loudly.
// `auni` (cli.ts) fills in DATABASE_URL and TURN_TOKEN_SECRET before anything imports this, when
// they're unset. An app's settings are its own: declared in its about.ts and read where they are
// used (settings.ts).
const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(4000),
    // The address core listens on: this machine only by default, as the web app's /core rewrite
    // reaches it here wherever Auni runs (hosts/). Requests still need the owner's session.
    HOST: z.string().min(1).default("127.0.0.1"),
    // Where `auni` runs the web app: this machine only by default, like core; 0.0.0.0 in a
    // container (the Dockerfile), whose port mapping says who reaches it.
    WEB_HOST: z.string().min(1).default("127.0.0.1"),
    WEB_PORT: z.coerce.number().int().positive().default(3000),
    // Where the browser opens the web app: it reaches core through it (its /core rewrite),
    // pairing links point at it, and requests that change something must come from it. Unset,
    // http://localhost:<WEB_PORT>; set it when a proxy or a domain of your own fronts the app.
    WEB_ORIGIN: baseUrlSchema.optional(),
    // The owner's Tailscale login, which `auni up --always-on` records with WEB_ORIGIN, this
    // machine's https address on their tailnet. Set, Auni is reached only through `tailscale
    // serve` and the owner is whoever Tailscale says this login is (auth/tailscale.ts): there's
    // no pairing. Unset, a browser on this computer, paired with `auni pair`.
    TAILSCALE_OWNER: z.string().trim().min(1).optional(),

    // Your own Postgres. Unset, `auni` runs one of its own in the data folder (db/embedded.ts).
    DATABASE_URL: z.string().min(1),

    // The wallet app that holds the owner's money (a folder in src/apps); unset, the
    // default one. Where Auni keeps what lives on this machine, AUNI_HOME, is data-dir.ts's.
    WALLET: z.string().min(1).optional(),
    // Alchemy's RPC for every chain without an RPC_URL_<CHAIN> of its own (rpcUrlVar): steadier
    // than the public ones, which rate-limit. Unset, the public ones (money/chains.ts).
    ALCHEMY_API_KEY: z.string().min(1).optional(),

    // The brain app Auni thinks with first (a folder in src/apps); unset, the first in
    // apps/order.ts whose CLI is logged in on this machine. Another that's logged in takes over while this one
    // is at its usage limit.
    BRAIN: z.string().min(1).optional(),
    // Signs the per-turn token the agent's tools (core's MCP server) take, and seals cards.
    // Unset, `auni` makes one once and keeps it in the data folder.
    TURN_TOKEN_SECRET: z.string().min(32),
    // Set to anything, core also logs what helps whoever works on Auni: each turn's timing.
    AUNI_DEBUG: z.string().min(1).optional(),
  })
  .refine((value) => !value.TAILSCALE_OWNER || httpsOrigin(value.WEB_ORIGIN), {
    path: ["WEB_ORIGIN"],
    message: "TAILSCALE_OWNER needs WEB_ORIGIN set to this machine's https address on the tailnet",
  })
  .transform((value) => ({
    ...value,
    WEB_ORIGIN: value.WEB_ORIGIN ?? `http://localhost:${value.WEB_PORT}`,
  }));

function httpsOrigin(origin: string | undefined): boolean {
  return origin !== undefined && new URL(origin).protocol === "https:";
}

/**
 * The variable that names an RPC of the owner's own for one of Auni's networks: RPC_URL_MONAD,
 * RPC_URL_SOLANA. Set, Auni reads and sends on that chain through it alone (money/chains.ts).
 */
export function rpcUrlVar(chain: NetworkKey): string {
  return `RPC_URL_${chain.toUpperCase()}`;
}

const rpcUrlsSchema = z
  .object(Object.fromEntries(NETWORK_KEYS.map((chain) => [rpcUrlVar(chain), z.url().optional()])))
  .transform(
    (value) =>
      Object.fromEntries(
        NETWORK_KEYS.flatMap((chain) => {
          const url = value[rpcUrlVar(chain)];
          return url ? [[chain, url]] : [];
        }),
      ) as Partial<Record<NetworkKey, string>>,
  );

function parseEnv() {
  // An empty value (`KEY=` in a .env) means unset, as it does to a person reading the file.
  const set = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(set);
  const rpcUrls = rpcUrlsSchema.safeParse(set);
  if (!result.success || !rpcUrls.success) {
    console.error("Invalid environment configuration:");
    for (const issue of [...(result.error?.issues ?? []), ...(rpcUrls.error?.issues ?? [])]) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  return { ...result.data, RPC_URLS: rpcUrls.data };
}

export const env = parseEnv();
