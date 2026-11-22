import { NETWORKS } from "@auni/shared";
import { decodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";

import { chainKey } from "../../money/chains.ts";
import {
  PayInRefused,
  type PayInAnswer,
  type PayInRequest,
  type PayInStanding,
} from "../../money/pay-in.ts";
import { setting } from "../../settings.ts";
import about from "./about.ts";

// Relay (relay.link) moves money from one chain to another in a second or two: the sender
// approves Relay's depository for the amount and deposits it there under a request id (a
// chain's own coin goes in the deposit call itself), and a Relay solver pays the recipient on
// the other chain. This file asks Relay and reads its
// answer into core's names; core holds every answer to what was asked before anyone signs it
// (money/pay-in.ts). Relay's API is public; its key, when set, is sent as its docs ask.

export const RELAY_API = "https://api.relay.link";

/** Relay's depository, at one address on every EVM chain it serves (checked on each, 2026-11). */
export const DEPOSITORY: Address = "0x4cd00e387622c35bddb9b4c962c136462338bc31";

/** Relay's id for Solana, and its name for SOL itself there. */
const SOLANA = { chainId: 792_703_809, sol: "11111111111111111111111111111111" };

const depositoryAbi = parseAbi([
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
  "function depositNative(address depositor, bytes32 id) payable",
]);

/**
 * A call to the depository, read as the deposit it makes; throws for any other call. A deposit
 * of the chain's own coin names no amount: it is the coin the call carries, `value`.
 */
export function deposit(
  data: Hex,
  value: bigint,
): {
  readonly depositor: Address;
  readonly token: Address | "native";
  readonly amount: bigint;
} {
  const call = decodeFunctionData({ abi: depositoryAbi, data });
  if (call.functionName === "depositNative")
    return { depositor: call.args[0], token: "native", amount: value };
  const [depositor, token, amount] = call.args;
  return { depositor, token, amount };
}

const TIMEOUT_MS = 15_000;

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/u) as z.ZodType<Hex>;
const units = z.string().regex(/^\d+$/u);
const currencyAmount = z.object({
  currency: z.object({ chainId: z.number(), address: z.string() }),
  amount: units,
  minimumAmount: units.nullish(),
});
const quoteSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      requestId: hex,
      items: z.array(
        z.object({
          data: z.object({
            chainId: z.number(),
            to: z.string(),
            data: hex,
            value: z.string().default("0"),
          }),
        }),
      ),
    }),
  ),
  details: z.object({
    recipient: z.string(),
    currencyOut: currencyAmount,
  }),
});

async function relay(path: string, init?: RequestInit): Promise<unknown> {
  const key = setting(about, "apiKey");
  const response = await fetch(`${RELAY_API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    throw new PayInRefused("Relay didn't answer.");
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `it answered ${response.status}`;
    throw new PayInRefused(message);
  }
  return body;
}

/** Relay's names for a chain and a token there, from core's (see PayInRequest.to). */
function named({ chain, token }: PayInRequest["to"]): { chainId: number; token: string } {
  if (chain === "solana")
    return { chainId: SOLANA.chainId, token: token === "native" ? SOLANA.sol : token };
  return { chainId: NETWORKS[chain].viem.id, token: token === "native" ? zeroAddress : token };
}

/** Core's names for a chain and a token Relay names, the other way (see named). */
function coreNamed(chainId: number, token: string): { chain: string; token: string } {
  if (chainId === SOLANA.chainId)
    return { chain: "solana", token: token === SOLANA.sol ? "native" : token };
  return { chain: chainKey(chainId), token: token === zeroAddress ? "native" : token };
}

/** Relay's quote for a request, as it answered. */
export async function quote(request: PayInRequest): Promise<PayInAnswer> {
  const to = named(request.to);
  return answered(
    await relay("/quote/v2", {
      method: "POST",
      body: JSON.stringify({
        user: request.user,
        recipient: request.recipient,
        originChainId: NETWORKS[request.from.chain].viem.id,
        originCurrency: request.from.token === "native" ? zeroAddress : request.from.token,
        destinationChainId: to.chainId,
        destinationCurrency: to.token,
        amount: request.amount.toString(),
        tradeType: "EXACT_INPUT",
      }),
    }),
  );
}

/** Relay's answer to a quote, read into core's names and changed in nothing else. */
export function answered(answer: unknown): PayInAnswer {
  const parsed = quoteSchema.safeParse(answer);
  if (!parsed.success) throw new PayInRefused("Relay answered with a quote Auni can't read.");
  const { steps, details } = parsed.data;
  const out = details.currencyOut;
  return {
    steps: steps.map(({ items, ...step }) => ({
      ...step,
      calls: items.map(({ data }) => ({ ...data, value: BigInt(data.value) })),
    })),
    pays: {
      recipient: details.recipient,
      ...coreNamed(out.currency.chainId, out.currency.address),
    },
    out: BigInt(out.amount),
    least: BigInt(out.minimumAmount ?? out.amount),
  };
}

const statusSchema = z.object({
  status: z.string(),
  refundFailReason: z.string().nullish(),
  txHashes: z.array(z.string()).nullish(),
});

/**
 * Where a request stands. Only success and refund are final; a failure is too only when Relay
 * says it won't refund it, as it otherwise retries or refunds. A success is one only once Relay
 * names the transaction that paid the recipient (its `txHashes`), as its docs say to read it.
 */
export async function status(requestId: Hex): Promise<PayInStanding> {
  const read = statusSchema.safeParse(
    await relay(`/intents/status/v3?requestId=${encodeURIComponent(requestId)}`),
  );
  if (!read.success) throw new PayInRefused("Relay answered with a status Auni can't read.");
  const answer = read.data;
  const paidIn = answer.txHashes ?? [];
  if (answer.status === "success" && paidIn.length > 0) return { status: "success", paidIn };
  if (answer.status === "refund") return { status: "refunded", paidIn: [] };
  if (answer.status === "failure" && answer.refundFailReason)
    return { status: "failed", paidIn: [] };
  return { status: "pending", paidIn: [] };
}
