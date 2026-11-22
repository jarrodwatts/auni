import { createHmac } from "node:crypto";

import { AUNI_REPO_URL } from "@auni/shared";
import type { Address } from "viem";

import { setting } from "../../settings.ts";
import { tryKeyAt, type KeyTried } from "../../try-key.ts";
import about from "./about.ts";

export const POLYGON = 137;
export const CLOB = "https://clob.polymarket.com";
export const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const RELAYER = "https://relayer-v2.polymarket.com";
const TIMEOUT_MS = 20_000;

// Polygon contracts as @polymarket/client 0.14.0 pins them.
export const CONTRACTS = {
  walletFactory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
  pusd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  standardExchange: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchange: "0xe2222d279d744050d28e00520010520000310F59",
  negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  collateralOnramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
  // Turns pUSD back into what backs it, one for one (docs.polymarket.com/resources/contracts).
  collateralOfframp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
  usdce: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  // Protocol V2: one exchange for every market, shares in the PositionManager.
  exchangeV3: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
  positionManager: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
  // Polymarket's own operator, which pays out resolved shares on either protocol to the
  // wallet that holds them, once that wallet lets it (the client's autoRedeemOperator).
  autoRedeemer: "0xa1200000d0002264C9a1698e001292D00E1b00af",
} as const satisfies Record<string, Address>;

export class VenueError extends Error {
  readonly service: string;
  readonly status: number;
  readonly body: string;

  constructor(service: string, status: number, body: string) {
    super(`${service} answered HTTP ${status}: ${body.slice(0, 300)}`);
    this.service = service;
    this.status = status;
    this.body = body;
  }

  get reason(): string {
    const match = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(this.body);
    return match?.[1] ?? this.body.slice(0, 300);
  }

  /** What it refused, in the service's words, then who answered and how: what problems.ts reads. */
  get said(): string {
    return `${this.reason} (${this.service}, HTTP ${this.status})`.trim();
  }
}

async function request(service: string, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) throw new VenueError(service, response.status, text);
  // The CLOB answers an order it never saw with an empty 200, not a 404.
  return text.trim() === "" ? null : (JSON.parse(text) as unknown);
}

export function getJson<T>(url: string): Promise<T> {
  return request(new URL(url).hostname, url, { method: "GET" }) as Promise<T>;
}

/** Most pages one read of the data API walks: past any Auni wallet's positions or payouts. */
const DATA_PAGES = 10;

/**
 * Every row a data API v2 feed lists for `query` (`/v2/positions`, `/v2/activity`), 1,000 a page.
 * The API pages by cursor only, and a cursor works only beside the filters it was minted with,
 * so each page asks again with all of them. Throws past DATA_PAGES pages, and with the API's
 * own words when it refuses: it retired v1 with a 410 that said so (November 2026).
 */
export async function dataRows<Row>(
  path: `/v2/${string}`,
  query: Record<string, string>,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < DATA_PAGES; page += 1) {
    const search = new URLSearchParams({ ...query, limit: "1000" });
    if (cursor) search.set("cursor", cursor);
    const body = (await request("Polymarket data API", `${DATA}${path}?${search}`, {
      method: "GET",
      // Cloudflare in front of the data API refuses requests without a User-Agent.
      headers: { "user-agent": `auni (+${AUNI_REPO_URL})` },
    })) as { data: Row[] | null; pagination: { next_cursor: string | null } };
    // A user with no rows comes back as null data rather than an empty list.
    rows.push(...(body.data ?? []));
    cursor = body.pagination.next_cursor;
    if (!cursor) return rows;
  }
  throw new Error(`Polymarket's ${path} ran past ${DATA_PAGES} pages.`);
}

export function clobRequest(
  method: "GET" | "POST" | "DELETE",
  pathAndQuery: string,
  headers: Record<string, string>,
  body?: string,
): Promise<unknown> {
  return request("Polymarket CLOB", `${CLOB}${pathAndQuery}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

export function hmacSignature(secret: string, message: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(message)
    .digest("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

/** The owner's builder credentials, each by its setting's key in about.ts. */
type Builder = Readonly<Record<"builderKey" | "builderSecret" | "builderPassphrase", string>>;

/** The builder credentials as they are now, with `typed` in place of any it names; null while one is missing. */
export function builderCredentials(typed: Partial<Builder> = {}): Builder | null {
  const read = (key: keyof Builder) => typed[key] ?? setting(about, key);
  const [builderKey, builderSecret, builderPassphrase] = [
    read("builderKey"),
    read("builderSecret"),
    read("builderPassphrase"),
  ];
  return builderKey && builderSecret && builderPassphrase
    ? { builderKey, builderSecret, builderPassphrase }
    : null;
}

/** The relayer's builder headers for one request. Its HMAC covers the path without its query string. */
function builderHeaders(
  builder: Builder,
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    POLY_BUILDER_API_KEY: builder.builderKey,
    POLY_BUILDER_PASSPHRASE: builder.builderPassphrase,
    POLY_BUILDER_TIMESTAMP: timestamp,
    POLY_BUILDER_SIGNATURE: hmacSignature(
      builder.builderSecret,
      `${timestamp}${method}${path}${body ?? ""}`,
    ),
  };
}

export function relayerRequest(
  method: "GET" | "POST",
  path: string,
  query: Record<string, string> = {},
  body?: string,
): Promise<unknown> {
  const builder = builderCredentials();
  if (!builder) {
    throw new Error(
      "Polymarket isn't set up to trade yet: its builder key, secret and passphrase haven't been added.",
    );
  }
  const search = new URLSearchParams(query).toString();
  return request("Polymarket relayer", `${RELAYER}${path}${search ? `?${search}` : ""}`, {
    method,
    headers: {
      ...builderHeaders(builder, method, path, body),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Tries the builder credentials with `typed` in place of the setting it names: the relayer's
 * list of the builder's recent transactions, which reads nothing of the owner's. Null while
 * one of the three is still to come.
 */
export async function tryBuilder(key: string, value: string): Promise<KeyTried | null> {
  const builder = builderCredentials({ [key]: value });
  if (!builder) return null;
  return tryKeyAt(`${RELAYER}/transactions`, {
    headers: builderHeaders(builder, "GET", "/transactions"),
  });
}
