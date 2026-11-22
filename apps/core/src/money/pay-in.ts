import { NETWORKS, type EvmChainKey, type NetworkKey } from "@auni/shared";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import type { PayIn } from "../apps/contract.ts";
import type { EvmTx } from "./recipe.ts";

// Paying in: money carried from one chain to a recipient on another in a second or two. The
// sender approves a service's depository for the amount and deposits it there under a request
// id, and the service pays the recipient on the other chain. Core uses it three times: for
// paying into Auni from a browser wallet (routes/funding.ts), for the SOL a wallet that pays
// its own Solana fees buys with its USDC on Monad (sol-top-up.ts), and for the coin an EVM
// chain's fees are paid in, bought from a chain that can pay (fee-coin.ts). The app that fills
// the payIn role (apps/contract.ts) asks its service; what may be asked, and the check on every
// answer, are core's and are here.
//
//   payInQuote -> [approve USDC to the depository, deposit it there] -> payInStatus
//   payInQuote -> [deposit the chain's own coin there, carried by the call] -> payInStatus
//
// Every quote is checked before anyone sees or signs it: each step is a transaction on the
// origin chain that calls only the origin token (an exact approval of the depository) or the
// depository itself (a deposit of exactly that amount, from the sender), and the service says
// it pays the recipient asked for, with what was asked for. A token's steps send no coin; the
// chain's own coin goes in one deposit that carries exactly the amount and nothing is approved.
// Anything else is refused whole.

export interface PayInRequest {
  /** Who sends: the wallet that signs the steps. */
  readonly user: Address;
  /** Who is paid on the destination chain. */
  readonly recipient: string;
  /** What is sent, and from where: a token by its address, or "native" for the chain's own coin. */
  readonly from: { readonly chain: EvmChainKey; readonly token: Address | "native" };
  /** What arrives, and where: a token by its address or mint, or "native" for the chain's own coin. */
  readonly to: { readonly chain: NetworkKey; readonly token: string };
  /** What `user` sends, in the origin token's base units. */
  readonly amount: bigint;
  /** Dollars of `amount` that arrive as the destination chain's coin, for its fees. */
  readonly topUpUsd?: number;
}

/**
 * What a pay-in service answered, as its app hands it over: read, put in core's names, and not
 * yet believed (see checkedQuote).
 */
export interface PayInAnswer {
  readonly steps: readonly {
    readonly id: string;
    /** "transaction" for calls the sender's wallet sends; a step of any other kind is refused. */
    readonly kind: string;
    readonly description: string;
    /** The service's own id for the request this step belongs to. */
    readonly requestId: Hex;
    readonly calls: readonly {
      readonly chainId: number;
      readonly to: string;
      readonly data: Hex;
      readonly value: bigint;
    }[];
  }[];
  /** Who it says it pays, and what with, named as a request's `to` is. */
  readonly pays: { readonly recipient: string; readonly chain: string; readonly token: string };
  /** What the recipient gets, in the destination token's base units. */
  readonly out: bigint;
  /** The least it gets once the service's slippage is spent. */
  readonly least: bigint;
  /** The destination chain's coin the top-up brings, in its base units; null without one. */
  readonly gas: bigint | null;
  /** About how long it takes, in seconds. */
  readonly seconds: number | null;
}

/** One call a step makes, as the sender's wallet sends it. */
interface PayInCall {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  /** The coin the call carries: all of a deposit of the chain's own coin, and nothing otherwise. */
  readonly value: bigint;
}

/** A quote held to its request: every step is one the sender may sign (see the top). */
export interface PayInQuote extends Pick<PayInAnswer, "out" | "least" | "gas" | "seconds"> {
  /** The service's name, for what a person reads of it. */
  readonly by: string;
  readonly requestId: Hex;
  readonly steps: readonly {
    readonly id: "approve" | "deposit";
    readonly description: string;
    readonly call: PayInCall;
  }[];
}

export type PayInStatus = "pending" | "success" | "refunded" | "failed";

/** Where a request stands, and what paid it. */
export interface PayInStanding {
  readonly status: PayInStatus;
  /**
   * Once it succeeded, the transactions on the destination chain that paid the recipient, by
   * hash: the service sends them, so nothing of the sender's own names them otherwise.
   */
  readonly paidIn: readonly string[];
}

/** The service didn't answer, turned the ask away, or quoted what Auni won't hand on: nothing to sign. */
export class PayInRefused extends Error {}

/**
 * The pay-in app core quotes through: the first apps/order.ts names. Apps top up SOL through
 * sol-top-up.ts, and the registry loads every app, so it is looked up when asked for.
 */
async function firstPayIn(): Promise<{ readonly name: string; readonly payIn: PayIn }> {
  const [first] = (await import("../apps/registry.ts")).filling("payIn");
  if (!first) throw new PayInRefused("No app quotes paying in.");
  return { name: first.about.name, payIn: first.part };
}

/** A quote to carry `amount` of an ERC-20 from one chain to a recipient on another, checked (see the top). */
export async function payInQuote(request: PayInRequest): Promise<PayInQuote> {
  if (request.from.token !== "native" && isAddressEqual(request.from.token, zeroAddress))
    throw new Error('A chain\'s own coin is named "native", never by the zero address.');
  const { name, payIn } = await firstPayIn();
  return checkedQuote(request, { name, ...payIn }, await payIn.quote(request));
}

/** Where a request stands, as the app that quoted it says (see PayIn.status). */
export async function payInStanding(requestId: Hex): Promise<PayInStanding> {
  return (await firstPayIn()).payIn.status(requestId);
}

/** The quote a service answered, held to exactly what `request` asked for. */
export function checkedQuote(
  request: PayInRequest,
  service: Pick<PayIn, "depository" | "deposit"> & { readonly name: string },
  answer: PayInAnswer,
): PayInQuote {
  const refuse = (why: string): never => {
    throw new PayInRefused(`${service.name}'s quote ${why}, so Auni won't hand it on.`);
  };

  const requestId = answer.steps[0]?.requestId ?? refuse("has no steps");
  if (!sameAddress(answer.pays.recipient, request.recipient)) refuse("pays someone else");
  if (answer.pays.chain !== request.to.chain || !sameToken(answer.pays.token, request.to.token))
    refuse("pays out something else");

  const checked = answer.steps.map((step) =>
    checkedStep(request, service, requestId, step, refuse),
  );
  if (checked.filter(({ id }) => id === "deposit").length !== 1) refuse("doesn't deposit once");
  if (checked.at(-1)?.id !== "deposit") refuse("doesn't end in its deposit");

  const { out, least, gas, seconds } = answer;
  return { by: service.name, requestId, steps: checked, out, least, gas, seconds };
}

/** One step, as the sender's wallet would send it, held to the request (see the top). */
function checkedStep(
  request: PayInRequest,
  service: Pick<PayIn, "depository" | "deposit"> & { readonly name: string },
  requestId: Hex,
  step: PayInAnswer["steps"][number],
  refuse: (why: string) => never,
): PayInQuote["steps"][number] {
  const [item, ...more] = step.calls;
  if (step.kind !== "transaction" || !item || more.length > 0)
    return refuse(`asks for a "${step.kind}" step`);
  const { chainId, to, data, value } = item;
  if (step.requestId !== requestId) refuse("mixes requests");
  if (chainId !== NETWORKS[request.from.chain].viem.id) refuse("sends on another chain");
  const { token: sends, amount: asked } = { ...request.from, amount: request.amount };
  // Only a deposit of the chain's own coin carries any, and exactly what was asked.
  if (value !== (sends === "native" && step.id === "deposit" ? asked : 0n))
    refuse(sends === "native" ? "carries something other than the amount" : "sends coin");
  const call: PayInCall = { chainId, to: getAddress(to), data, value };
  // A call whose data fits no function it should be is refused like any other.
  const decoded = <T>(decode: () => T): T => {
    try {
      return decode();
    } catch {
      return refuse(`calls ${to} with data Auni can't read`);
    }
  };
  if (step.id === "approve" && sends !== "native" && sameAddress(to, sends)) {
    const approve = decoded(() => decodeFunctionData({ abi: erc20Abi, data }));
    if (
      approve.functionName !== "approve" ||
      !isAddressEqual(approve.args[0], service.depository) ||
      approve.args[1] !== request.amount
    )
      refuse(`approves something other than the amount, to ${service.name}`);
    return { id: "approve", description: step.description, call };
  }
  if (step.id === "deposit" && sameAddress(to, service.depository)) {
    // Its id is the service's own for the order, which says who it pays: the recipient checked above.
    const { depositor, token, amount } = decoded(() => service.deposit(data, value));
    if (!isAddressEqual(depositor, request.user) || !sameToken(token, sends) || amount !== asked)
      refuse("deposits something other than this request");
    return { id: "deposit", description: step.description, call };
  }
  return refuse(`calls ${to}, which is neither the token nor ${service.name}`);
}

/** Two tokens are one: a chain's own coin only itself, any other by its address. */
function sameToken(a: string, b: string): boolean {
  return a === "native" || b === "native" ? a === b : sameAddress(a, b);
}

const WAIT_MS = 120_000;
const POLL_MS = 2_000;

/**
 * Waits until the service has settled a quote whose deposit was sent, and says where it stands:
 * paid, which usually takes a second or two, refunded, or failed for good. One still pending
 * after 2 minutes is answered as pending: it may yet be paid or refunded.
 */
export async function payInSettled(requestId: Hex): Promise<PayInStanding> {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const standing = await payInStanding(requestId).catch((): PayInStanding => ({
      status: "pending",
      paidIn: [],
    }));
    if (standing.status !== "pending" || Date.now() > until) return standing;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * The calls a checked quote's steps make, as a move's wallet is handed them to buy the coin a
 * chain's fees are paid in: all as setup, and marked as the purchase by the service's id for
 * the order (EvmTx.buysFees), so the wallet keeps the send as its card's one purchase.
 */
export function payInCalls(quote: PayInQuote): EvmTx[] {
  return quote.steps.map(({ call: { to, data, value } }) => ({
    to,
    data,
    ...(value > 0n ? { value: value.toString() } : {}),
    setup: true as const,
    buysFees: quote.requestId,
  }));
}

/**
 * Two addresses are one: EVM ones in any case, Solana's (base58, where case counts) exactly.
 * Anything else matches nothing.
 */
function sameAddress(a: string, b: string): boolean {
  if (isAddress(a, { strict: false }) && isAddress(b, { strict: false }))
    return isAddressEqual(a, b);
  return SOLANA_ADDRESS.test(a) && a === b;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
