import { randomBytes } from "node:crypto";

import {
  encodeFunctionData,
  getAddress,
  pad,
  parseAbi,
  parseSignature,
  toHex,
  type Address,
} from "viem";

import { MayHaveSent, type KeptTx, type Signer } from "../../money/recipe.ts";
import { publicClient } from "../../money/chains.ts";
import { poll } from "../../money/poll.ts";
import { CONTRACTS, POLYGON, relayerRequest, VenueError } from "./http.ts";
import { signTyped, type TypedData } from "../../money/typed-data.ts";
import { refusal } from "./problems.ts";
import type { Call, Funding } from "./wallet.ts";

const transferWithAuthorizationAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

const PULL_DOMAINS = {
  [CONTRACTS.usdce]: {
    name: "USD Coin (PoS)",
    version: "1",
    verifyingContract: CONTRACTS.usdce,
    salt: pad(toHex(POLYGON), { size: 32 }),
  },
  [CONTRACTS.usdc]: {
    name: "USD Coin",
    version: "2",
    chainId: POLYGON,
    verifyingContract: CONTRACTS.usdc,
  },
} as const;

// The relayer allowlist accepts the owner's EIP-3009 pull, so the owner needs no Polygon gas.
async function pullCall(
  wallets: Signer,
  wallet: Address,
  pull: NonNullable<Funding["pull"]>,
  validBefore: bigint,
): Promise<Call> {
  const owner = getAddress(wallets.evmAddress);
  const authorization = {
    from: owner,
    to: wallet,
    value: pull.amount,
    validAfter: 0n,
    validBefore,
    nonce: toHex(randomBytes(32)),
  };
  const signature = await signTyped(wallets, {
    domain: PULL_DOMAINS[pull.asset as keyof typeof PULL_DOMAINS],
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const { r, s, v } = parseSignature(signature);
  return {
    target: pull.asset,
    data: encodeFunctionData({
      abi: transferWithAuthorizationAbi,
      functionName: "transferWithAuthorization",
      args: [
        owner,
        wallet,
        pull.amount,
        0n,
        validBefore,
        authorization.nonce,
        Number(v ?? 27n),
        r,
        s,
      ],
    }),
  };
}

export function batchTypedData(
  wallet: Address,
  nonce: bigint,
  deadline: bigint,
  calls: readonly Call[],
): TypedData {
  return {
    domain: { name: "DepositWallet", version: "1", chainId: POLYGON, verifyingContract: wallet },
    types: {
      Batch: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "calls", type: "Call[]" },
      ],
      Call: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
    },
    primaryType: "Batch",
    message: {
      wallet,
      nonce,
      deadline,
      calls: calls.map((call) => ({
        target: call.target,
        value: call.value ?? 0n,
        data: call.data,
      })),
    },
  };
}

// The factory's proxy() only forwards to an existing wallet, so a new one needs WALLET-CREATE.
export async function ensureDeployed(
  owner: Address,
  wallet: { readonly address: Address; readonly deployed: boolean },
): Promise<void> {
  if (wallet.deployed) return;
  await settle(
    await submit({
      from: owner,
      metadata: "auni deposit wallet",
      to: CONTRACTS.walletFactory,
      type: "WALLET-CREATE",
    }),
  );
  const visible = await poll(
    async () => {
      const code = await publicClient("polygon").getCode({ address: wallet.address });
      return code && code !== "0x" ? true : undefined;
    },
    { every: 2_000, tries: 15 },
  );
  if (visible) return;
  throw new Error(
    "Polymarket confirmed the wallet creation but it is not visible on Polygon yet. Retry in a minute.",
  );
}

/** A batch the owner's deposit wallet runs, all of it or none. */
export interface Batch {
  readonly calls: readonly Call[];
  /** What the batch first brings into the deposit wallet for a buy, before `calls`. */
  readonly funding?: Funding;
  /** A few words for the relayer's own record of the transaction. */
  readonly metadata: string;
  /** Whether it is a step before the move (approvals, funding) and not the move itself. */
  readonly setup: boolean;
}

/**
 * Sends a batch from the owner's deposit wallet through the relayer,
 * kept by the relayer's id the moment it takes it: the relayer, not their
 * wallet, puts it on chain, so until its hash is kept nothing else says that
 * the money it moves is Auni's own move (see sendingUnnamed in arrivals.ts),
 * and a run that stops waiting on it still settles from it. The wallet runs a
 * signed batch once (its nonce) and only until its deadline, ten minutes on.
 */
export async function runBatch(
  wallets: Signer,
  wallet: Address,
  { calls, funding, metadata, setup }: Batch,
  recordSent: (tx: KeptTx) => Promise<void>,
): Promise<string> {
  const owner = getAddress(wallets.evmAddress);
  const params = (await relayerRequest("GET", "/v1/account/transactions/params", {
    address: owner,
    type: "WALLET",
  })) as { nonce: string };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const pulls = funding?.pull ? [await pullCall(wallets, wallet, funding.pull, deadline)] : [];
  const all = [...pulls, ...(funding?.calls ?? []), ...calls];
  const signature = await signTyped(
    wallets,
    batchTypedData(wallet, BigInt(params.nonce), deadline, all),
  );
  const kept = { chain: "polygon", ...(setup ? { setup } : {}) } as const;
  const relayerId = await submit(
    {
      depositWalletParams: {
        calls: all.map((call) => ({
          data: call.data,
          target: call.target,
          value: (call.value ?? 0n).toString(),
        })),
        deadline: deadline.toString(),
        depositWallet: wallet,
      },
      from: owner,
      metadata,
      nonce: params.nonce,
      signature,
      to: CONTRACTS.walletFactory,
      type: "WALLET",
    },
    // A setup batch only readies the owner's own Polymarket wallet, and the move after it reads
    // what is there afresh, so one that got no answer fails as before. The move itself is never
    // failed on a guess.
    setup ? undefined : kept,
  );
  const sent = { ...kept, relayerId };
  await recordSent(sent);
  const hash = await settle(relayerId);
  await recordSent({ ...sent, hash });
  return hash;
}

/**
 * Hands the relayer a transaction and gives its id for it. Never resubmit: each attempt burns
 * the builder quota (100 a day) and the bytes are refused again. A 4xx is the relayer turning
 * it away, in its own words. Anything else (no answer, a server error) may be a transaction it
 * took all the same: with `unanswered`, what the action keeps of such a send, that is thrown as
 * MayHaveSent, so a move is never failed, and so tried again, while its first send may land.
 */
async function submit(body: Record<string, unknown>, unanswered?: KeptTx): Promise<string> {
  try {
    const response = (await relayerRequest("POST", "/submit", {}, JSON.stringify(body))) as {
      transactionID: string;
    };
    return response.transactionID;
  } catch (error) {
    const turnedAway = error instanceof VenueError && error.status < 500;
    if (unanswered && !turnedAway) throw new MayHaveSent(unanswered, "Polymarket's relayer", error);
    if (!(error instanceof VenueError)) throw error;
    // Met on the hosted service and never recorded, so it is worded here and not in problems.ts.
    if (/nonce|in.?flight|busy/iu.test(error.reason)) {
      throw new Error(
        "Your Polymarket wallet already has a transaction in flight, so nothing new was sent. It can go once that one settles.",
        { cause: error },
      );
    }
    throw refusal(error.said);
  }
}

/**
 * Where the relayer has a transaction it took: confirmed with its hash,
 * failed with why, or still pending. Only STATE_CONFIRMED settles;
 * STATE_MINED can be re-reported after a reorg.
 */
export async function relayed(
  transactionId: string,
): Promise<{ readonly hash: string } | { readonly failed: string } | "pending"> {
  const transaction = (await relayerRequest(
    "GET",
    `/v1/account/transactions/${encodeURIComponent(transactionId)}`,
  )) as {
    state: string;
    transaction_hash?: string | null;
    error_msg?: string | null;
  };
  if (transaction.state === "STATE_CONFIRMED" && transaction.transaction_hash)
    return { hash: transaction.transaction_hash };
  if (transaction.state === "STATE_FAILED" || transaction.state === "STATE_INVALID")
    return { failed: transaction.error_msg ?? transaction.state };
  return "pending";
}

async function settle(transactionId: string): Promise<string> {
  const hash = await poll(
    async () => {
      const found = await relayed(transactionId);
      if (found === "pending") return undefined;
      if ("failed" in found)
        throw new Error(
          `Polymarket's relayer transaction failed on chain, so nothing moved: ${found.failed}`,
        );
      return found.hash;
    },
    { every: 2_000, tries: 90 },
  );
  if (hash) return hash;
  throw new Error(
    `Polymarket's relayer transaction ${transactionId} is still pending after three minutes. Check the wallet before retrying so it is not sent twice.`,
  );
}
