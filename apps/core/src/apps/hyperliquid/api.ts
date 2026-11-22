import { MayHaveSent, type Signer } from "../../money/recipe.ts";
import type { Fields } from "../../money/typed-data.ts";
import { refusal, type ExchangeAnswer, type Taken } from "./problems.ts";
import {
  l1TypedData,
  signTypedData,
  userSignedTypedData,
  type HyperliquidSignature,
} from "./signing.ts";

const API = "https://api.hyperliquid.xyz";
const TIMEOUT_MS = 15_000;

export async function info<T>(body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const response = await fetch(`${API}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Hyperliquid could not answer ${String(body.type)} (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

let lastNonce = 0;

export function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

/** What moves money; the rest (an approval, a leverage change, a cancel) only sets a move up. */
const MOVES_MONEY = new Set(["order", "withdraw3"]);

async function postExchange(
  action: unknown,
  nonce: number,
  signature: HyperliquidSignature,
): Promise<ExchangeAnswer> {
  // An order or withdrawal Hyperliquid didn't answer may have gone through.
  const unanswered = (error: unknown) =>
    MOVES_MONEY.has(String((action as { type?: unknown }).type))
      ? new MayHaveSent({ chain: "hyperliquid" }, "Hyperliquid", error)
      : error;
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${API}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, nonce, signature }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
    if (response.ok) return JSON.parse(text) as ExchangeAnswer;
  } catch (error) {
    throw unanswered(error);
  }
  const error = new Error(
    `Hyperliquid rejected the request (HTTP ${response.status}): ${text.slice(0, 200)}`,
  );
  // Sent once, so a 4xx turned it away; a server error is no answer.
  throw response.status < 500 ? error : unanswered(error);
}

/** The answer when the exchange took the request; one it refused whole throws what it said (see problems.ts). */
function taken(answer: ExchangeAnswer): Taken {
  if (answer.status === "err") throw refusal(answer.response);
  return answer;
}

export async function sendL1(wallets: Signer, action: unknown): Promise<Taken> {
  const nonce = nextNonce();
  const signature = await signTypedData(wallets, l1TypedData(action, nonce));
  return taken(await postExchange(action, nonce, signature));
}

export async function sendUserSigned(
  wallets: Signer,
  primaryType: string,
  fields: Fields,
  action: Record<string, unknown> & { readonly nonce?: number; readonly time?: number },
): Promise<void> {
  const nonce = action.nonce ?? action.time;
  if (nonce === undefined) throw new Error("A user-signed Hyperliquid action needs a nonce");
  const signature = await signTypedData(
    wallets,
    userSignedTypedData(`HyperliquidTransaction:${primaryType}`, fields, action),
  );
  taken(await postExchange(action, nonce, signature));
}
