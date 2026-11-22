import { setTimeout as sleep } from "node:timers/promises";

import { getAddress, type Hex } from "viem";

import { MayHaveSent, type Signer } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import { CLOB, clobRequest, getJson, hmacSignature, POLYGON, VenueError } from "./http.ts";
import type { FeeTerms } from "./orders.ts";
import { refusal } from "./problems.ts";
import { signTyped } from "../../money/typed-data.ts";

interface ApiCredentials {
  readonly address: string;
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
}

const credentials = new Map<string, ApiCredentials>();

// Derivation from a ClobAuth signature is deterministic, so the key is re-derived, never stored.
export async function apiCredentials(wallets: Signer): Promise<ApiCredentials> {
  const address = getAddress(wallets.evmAddress);
  const cached = credentials.get(address);
  if (cached) return cached;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signTyped(wallets, {
    domain: { name: "ClobAuthDomain", version: "1", chainId: POLYGON },
    types: {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "ClobAuth",
    message: {
      address,
      timestamp,
      nonce: 0n,
      message: "This message attests that I control the given wallet",
    },
  });
  const headers = {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: "0",
  };
  let body: unknown;
  try {
    body = await clobRequest("POST", "/auth/api-key", headers);
  } catch (error) {
    if (!(error instanceof VenueError)) throw error;
    // Creating a key that exists fails; derive the same one back.
    body = await clobRequest("GET", "/auth/derive-api-key", headers);
  }
  const { apiKey, secret, passphrase } = body as {
    apiKey?: string;
    secret?: string;
    passphrase?: string;
  };
  if (!apiKey || !secret || !passphrase)
    throw new Error("Polymarket did not return API credentials.");
  const created = { address, apiKey, secret, passphrase };
  credentials.set(address, created);
  return created;
}

function authed(
  creds: ApiCredentials,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { readonly query?: Record<string, string>; readonly body?: string } = {},
): Promise<unknown> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const search = new URLSearchParams(options.query ?? {}).toString();
  const forgetRevokedKey = (error: unknown) => {
    if (error instanceof VenueError && error.status === 401) credentials.delete(creds.address);
    throw error;
  };
  return clobRequest(
    method,
    `${path}${search ? `?${search}` : ""}`,
    {
      POLY_ADDRESS: creds.address,
      POLY_SIGNATURE: hmacSignature(
        creds.secret,
        `${timestamp}${method}${path}${options.body ?? ""}`,
      ),
      POLY_TIMESTAMP: timestamp,
      POLY_API_KEY: creds.apiKey,
      POLY_PASSPHRASE: creds.passphrase,
    },
    options.body,
  ).catch(forgetRevokedKey);
}

// The CLOB caches balances and allowances and refuses orders on stale ones after a setup batch.
export async function refreshBalances(
  creds: ApiCredentials,
  shares?: { readonly tokenId: bigint; readonly assetType: "CONDITIONAL" | "CONDITIONAL-V2" },
): Promise<void> {
  await authed(creds, "GET", "/balance-allowance/update", {
    query:
      shares === undefined
        ? { asset_type: "COLLATERAL", signature_type: "3" }
        : {
            asset_type: shares.assetType,
            token_id: shares.tokenId.toString(),
            signature_type: "3",
          },
  });
}

export interface PlacedOrder {
  readonly orderId: string;
  readonly status: string;
  readonly makingAmount?: string;
  readonly takingAmount?: string;
  readonly transactionHashes: readonly string[];
  readonly tradeIds: readonly string[];
}

export async function postOrder(creds: ApiCredentials, body: string): Promise<PlacedOrder> {
  let response: {
    success?: boolean;
    errorMsg?: string;
    orderID?: string;
    status?: string;
    makingAmount?: string;
    takingAmount?: string;
    transactionsHashes?: string[] | null;
    tradeIDs?: string[] | null;
  };
  try {
    response = (await authed(creds, "POST", "/order", { body })) as typeof response;
  } catch (error) {
    if (error instanceof VenueError) {
      // Sent once, so a 4xx turned it away, and says why (see problems.ts). So did a server
      // error whose words are a refusal Polymarket's docs give for an exchange that is paused
      // or taking no such orders: those say outright that the order was not accepted.
      const said = refusal(error.said);
      if (error.status < 500 || said instanceof Refused) throw said;
    }
    // No answer, or a server error that says nothing of the order: the book may have taken
    // it, so it is kept as an order taken with no hash yet.
    throw new MayHaveSent({ chain: "polygon" }, "Polymarket", error);
  }
  if (!response.success || response.errorMsg || !response.orderID)
    throw refusal(response.errorMsg || "it gave no reason");
  return {
    orderId: response.orderID,
    status: (response.status ?? "").toLowerCase(),
    ...(response.makingAmount ? { makingAmount: response.makingAmount } : {}),
    ...(response.takingAmount ? { takingAmount: response.takingAmount } : {}),
    transactionHashes: response.transactionsHashes ?? [],
    tradeIds: response.tradeIDs ?? [],
  };
}

export async function tradeHashes(
  creds: ApiCredentials,
  tradeIds: readonly string[],
): Promise<string[]> {
  const hashes = new Set<string>();
  for (let attempt = 0; attempt < 10 && hashes.size < tradeIds.length; attempt += 1) {
    await sleep(1_500);
    for (const id of tradeIds) {
      const page = (await authed(creds, "GET", "/data/trades", { query: { id } })) as
        { data?: { transaction_hash?: string }[] } | { transaction_hash?: string }[] | null;
      const trades = Array.isArray(page) ? page : (page?.data ?? []);
      for (const trade of trades) if (trade.transaction_hash) hashes.add(trade.transaction_hash);
    }
  }
  return [...hashes];
}

export async function orderStatus(
  creds: ApiCredentials,
  orderId: string,
): Promise<{ readonly status: string; readonly sizeMatched: string } | null> {
  try {
    const order = (await authed(creds, "GET", `/data/order/${orderId}`)) as {
      status?: string;
      size_matched?: string;
    } | null;
    return order?.status
      ? {
          status: order.status.toLowerCase().replace(/^order_status_/u, ""),
          sizeMatched: order.size_matched ?? "0",
        }
      : null;
  } catch (error) {
    if (error instanceof VenueError && error.status === 404) return null;
    throw error;
  }
}

export interface Book {
  readonly asks: readonly { readonly price: string; readonly size: string }[];
  readonly bids: readonly { readonly price: string; readonly size: string }[];
}

export function orderBook(tokenId: bigint): Promise<Book> {
  return getJson<Book>(`${CLOB}/book?token_id=${tokenId}`);
}

/** Polymarket's own fee on a market's orders. */
export async function feeTerms(conditionId: Hex): Promise<FeeTerms> {
  const market = await getJson<{ fd?: { r: number; e: number } }>(
    `${CLOB}/clob-markets/${conditionId}`,
  );
  return {
    rateMicros: market.fd ? BigInt(Math.round(market.fd.r * 1_000_000)) : 0n,
    exponent: market.fd ? BigInt(market.fd.e) : 0n,
  };
}
