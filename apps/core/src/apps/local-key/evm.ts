import { and, count, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import {
  BaseError,
  HttpRequestError,
  isAddressEqual,
  keccak256,
  parseTransaction,
  TimeoutError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";

import { db, inTurn, type Database } from "../../db/client.ts";
import { actions } from "../../db/schema.ts";
import { signedTxs, type SignedTxRow } from "./tables.ts";
import { chainIdOf, chainKey, chainLabel, evmClient } from "../../money/chains.ts";
import { batchCall, delegatedTo, plainCall } from "../../money/account-code.ts";
import { MayHaveSent, type EvmSend, type EvmTx, type KeptTx } from "../../money/recipe.ts";
import { assertOwnGas, gasLimit, ownGasFees } from "../../money/gas.ts";
import type { SignerOptions } from "../../money/wallets.ts";

/**
 * MetaMask's EIP7702StatelessDeleGator v1.3.0 (delegation-framework, audited), which a list of
 * calls runs through as one transaction, all or nothing. It's deployed by CREATE2, and a CREATE2
 * address commits to its init code, so code at this address on any chain is this contract.
 */
export const DELEGATOR: Address = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";

/** The DeleGator's delegation manager, which redeems delegations the key signs. */
export const DELEGATION_MANAGER: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";

/** The code of an account delegated to the DeleGator. */
export const DELEGATED = delegatedTo(DELEGATOR);

const CONFIRM_TIMEOUT_MS = 180_000;

/** A send unmined this long, its fee cap under today's, is stuck (see replaceStuck). */
const STUCK_MS = 180_000;
/** Each replacement raises every fee by at least an eighth: nodes take a replacement only above a tenth. */
const BUMP = { times: 9n, over: 8n };
/** The most times one send is replaced before it's left to a person. */
const MOST_REPLACEMENTS = 3;

// Whether the DeleGator is on a chain never changes once it is.
const delegatorOn = new Map<number, true>();

async function hasDelegator(client: PublicClient, chainId: number): Promise<boolean> {
  if (delegatorOn.has(chainId)) return true;
  const code = await client.getCode({ address: DELEGATOR });
  if (!code || code === "0x") return false;
  delegatorOn.set(chainId, true);
  return true;
}

/**
 * The one transaction these calls go out as from `owner`, said with nothing signed: one call as
 * built, or a list as one call from the account to itself, which the DeleGator runs call by
 * call, all or nothing. The send that carries a list delegates the account to the DeleGator
 * when it isn't yet; one delegated elsewhere (an imported one) is moved over the same way.
 * Null for a list on a chain without the DeleGator, where it can't go as one.
 */
export async function asSent(
  chainId: number,
  owner: Address,
  txs: readonly EvmTx[],
): Promise<EvmSend | null> {
  const [only, ...more] = txs;
  if (only && more.length === 0) return plainCall(only);
  const client = evmClient(chainId);
  if (!(await hasDelegator(client, chainId))) return null;
  const delegated = (await client.getCode({ address: owner }))?.toLowerCase() === DELEGATED;
  return { ...batchCall(owner, txs), ...(delegated ? {} : { delegates: DELEGATOR }) };
}

/**
 * Signs and sends one move's EVM transaction from the local key: one call as built, or a list
 * as one all-or-nothing call through the DeleGator, delegating the account to it first when it
 * isn't. The signed bytes are journalled before they go, so nothing is ever signed twice for one
 * send; it waits until the transaction lands.
 */
export async function sendEvmTransaction(
  account: PrivateKeyAccount,
  chainId: number,
  txs: readonly EvmTx[],
  options: SignerOptions,
): Promise<string> {
  const client = evmClient(chainId);
  const chain = chainKey(chainId);
  const send = await asSent(chainId, account.address, txs);
  if (!send)
    throw new Error(
      `Auni can't send these calls all-or-nothing on ${chainLabel(chain)}, so nothing was sent.`,
    );
  await assertOwnGas(chainId, account.address, txs);
  const { delegates, ...call } = send;
  const fees = await ownGasFees(chainId);

  const sign = async (nonce: number) => {
    const common = {
      chainId,
      nonce,
      ...call,
      // The limit assertOwnGas judged the wallet's balance by, asked again in the account's turn.
      gas: await gasLimit(client, account.address, send),
      maxFeePerGas: fees.maxFee,
      maxPriorityFeePerGas: fees.tip,
    };
    if (!delegates) return account.signTransaction({ ...common, type: "eip1559" });
    // The send itself takes nonce N, so the authorization in it takes N + 1.
    const authorization = await account.signAuthorization({
      chainId,
      address: delegates,
      nonce: nonce + 1,
    });
    return account.signTransaction({
      ...common,
      type: "eip7702",
      authorizationList: [authorization],
    });
  };
  const kept = (row: SignedTxRow): KeptTx => ({
    chain,
    hash: row.hash,
    walletTxId: row.id,
    ...(txs.every((tx) => tx.setup) ? { setup: true as const } : {}),
  });

  // Sends from one account take turns from picking a nonce until a node answers, so a nonce a
  // node refused is free again before the next send picks one: none is signed above a hole.
  const row = await inTurn(`evm-send:${chain}:${account.address}`, async (conn) => {
    const nonce = await nextNonce(conn, client, chain, account);
    const raw = await sign(nonce);
    // Journalled and kept on its action as one write, so neither knows a send the other doesn't.
    const row = await conn.transaction(async (within) => {
      const [row] = await within
        .insert(signedTxs)
        .values({
          actionId: options.actionId,
          chain,
          address: account.address,
          nonce,
          raw,
          hash: keccak256(raw),
        })
        .returning();
      await options.onSent(kept(row!), within);
      return row!;
    });
    const answer = await deliver(conn, client, row);
    const where = chainLabel(chain);
    if ("unanswered" in answer) throw new MayHaveSent(kept(row), where, answer.unanswered);
    if ("refused" in answer) {
      const reason =
        answer.refused instanceof BaseError ? answer.refused.shortMessage : String(answer.refused);
      throw new Error(`Nothing was sent: ${where} refused it (${reason}).`);
    }
    return row;
  });
  return landed(client, row.hash as Hex, chain);
}

/**
 * The account's next nonce, in its turn (see sendEvmTransaction): the lowest from the node's
 * pending count up that no live send holds, so one still unanswered keeps its own and a hole
 * below it is filled.
 */
async function nextNonce(
  conn: Database,
  client: PublicClient,
  chain: string,
  account: PrivateKeyAccount,
): Promise<number> {
  const held = await deliverUnmined(conn, client, chain, account.address, account);
  let nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  while (held.has(nonce)) nonce += 1;
  return nonce;
}

/** A send that still holds its nonce: no node refused it, and none took over from it. */
const live = and(isNull(signedTxs.rejectedAt), isNull(signedTxs.replacedAt));

/**
 * Sends journalled earlier that the chain hasn't mined go out again, in the account's turn: one
 * that never reached a node leaves no gap, one a node now refuses frees its nonce, and one stuck
 * behind a fee the chain has passed is replaced (see replaceStuck), so it can't hold every later
 * nonce back. The nonces still held by a live send.
 */
async function deliverUnmined(
  conn: Database,
  client: PublicClient,
  chain: string,
  address: Address,
  account: PrivateKeyAccount | null,
): Promise<Set<number>> {
  const latest = await client.getTransactionCount({ address, blockTag: "latest" });
  const unmined = await conn
    .select()
    .from(signedTxs)
    .where(
      and(
        eq(signedTxs.chain, chain),
        eq(signedTxs.address, address),
        live,
        gte(signedTxs.nonce, latest),
      ),
    )
    .orderBy(signedTxs.nonce);
  const held = new Set<number>();
  for (const sent of unmined)
    if (!("refused" in (await deliverOrReplace(conn, client, account, sent))))
      held.add(sent.nonce!);
  return held;
}

/**
 * Delivers, again, each send journalled for a move still running that the chain hasn't mined:
 * the same bytes, so a send cut off between signing and broadcasting goes out once, never
 * signed twice, unless `account` signed it and it is stuck (see replaceStuck). Without this it
 * would wait for the account's next send, or reconcile.
 */
export async function resendEvm(account: PrivateKeyAccount | null): Promise<void> {
  const accounts = await db
    .selectDistinct({ chain: signedTxs.chain, address: signedTxs.address })
    .from(signedTxs)
    .innerJoin(actions, eq(actions.id, signedTxs.actionId))
    .where(and(eq(actions.status, "running"), isNotNull(signedTxs.nonce), live));
  for (const { chain, address } of accounts) {
    await inTurn(`evm-send:${chain}:${address}`, (conn) =>
      deliverUnmined(conn, evmClient(chainIdOf(chain)), chain, address as Address, account),
    ).catch((error: unknown) => console.error(`unmined sends on ${chain} not resent`, error));
  }
}

/**
 * Delivers a live send again, or the send that replaces it when it's stuck and `account` (the
 * key this wallet holds now) signed it.
 */
async function deliverOrReplace(
  conn: Database,
  client: PublicClient,
  account: PrivateKeyAccount | null,
  row: SignedTxRow,
): ReturnType<typeof deliver> {
  const replacement = await (
    account ? replaceStuck(conn, client, account, row) : Promise.resolve(null)
  ).catch((error: unknown) => {
    // Not replaced is no worse than before: it goes out again as it is.
    console.error(`stuck send ${row.hash} on ${row.chain} not replaced`, error);
    return null;
  });
  if (replacement) {
    const answer = await deliver(conn, client, replacement);
    if (!("refused" in answer)) return answer;
  }
  // The send itself holds the nonce again, so it's what decides.
  return deliver(conn, client, row);
}

/**
 * In the account's turn: a send unmined past STUCK_MS, whose fee cap is under today's, is signed
 * again with higher fees: the same call, at the same nonce, journalled (the old one marked
 * replaced, the new one kept for the same move) before it goes out. Both hold one nonce, so at
 * most one of them lands, and either does exactly what the card showed. It's left as it is when
 * the wallet can't pay the higher fee, after MOST_REPLACEMENTS, or when this key didn't sign it.
 * The new row, or null.
 */
async function replaceStuck(
  conn: Database,
  client: PublicClient,
  account: PrivateKeyAccount,
  row: SignedTxRow,
): Promise<SignedTxRow | null> {
  if (row.nonce === null || Date.now() - row.createdAt.getTime() < STUCK_MS) return null;
  if (!isAddressEqual(account.address, row.address as Address)) return null;
  const old = parseTransaction(row.raw as Hex);
  if ((old.type !== "eip1559" && old.type !== "eip7702") || !old.to) return null;
  const chainId = chainIdOf(row.chain);
  const today = await ownGasFees(chainId);
  if (old.maxFeePerGas === undefined || old.maxFeePerGas >= today.maxFee) return null;
  const [made] = await conn
    .select({ sends: count() })
    .from(signedTxs)
    .where(
      and(
        eq(signedTxs.actionId, row.actionId),
        eq(signedTxs.chain, row.chain),
        eq(signedTxs.address, row.address),
        eq(signedTxs.nonce, row.nonce),
      ),
    );
  if ((made?.sends ?? 0) > MOST_REPLACEMENTS) return null;

  const bumped = (was: bigint | undefined, now: bigint) => {
    const raised = ((was ?? 0n) * BUMP.times + BUMP.over - 1n) / BUMP.over;
    return raised > now ? raised : now;
  };
  const maxFeePerGas = bumped(old.maxFeePerGas, today.maxFee);
  const maxPriorityFeePerGas = bumped(old.maxPriorityFeePerGas, today.tip);
  const gas = old.gas ?? 0n;
  const value = old.value ?? 0n;
  // A node takes no send the wallet can't pay for at its fee cap.
  if ((await client.getBalance({ address: account.address })) < gas * maxFeePerGas + value)
    return null;
  const common = {
    chainId,
    nonce: row.nonce,
    to: old.to,
    ...(old.data ? { data: old.data } : {}),
    value,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  // The authorization it carries was signed for the nonce after this one, so it holds as it is.
  const raw =
    old.type === "eip7702"
      ? await account.signTransaction({
          ...common,
          type: "eip7702",
          authorizationList: old.authorizationList!,
        })
      : await account.signTransaction({ ...common, type: "eip1559" });
  return conn.transaction(async (within) => {
    // Marked first, so the new one can hold the nonce.
    await within.update(signedTxs).set({ replacedAt: new Date() }).where(eq(signedTxs.id, row.id));
    const [replacement] = await within
      .insert(signedTxs)
      .values({
        actionId: row.actionId,
        chain: row.chain,
        address: row.address,
        nonce: row.nonce,
        raw,
        hash: keccak256(raw),
        replaces: row.id,
      })
      .returning();
    return replacement!;
  });
}

/**
 * Sends journalled bytes, and says what the node made of them. No answer may still have reached
 * the network. A node that answers with an error may only be saying it has the transaction
 * already, so only one it can't find was refused: its row is marked, freeing its nonce. Called
 * only in the account's turn, so no send picks a nonce between the refusal and the mark.
 */
async function deliver(
  conn: Database,
  client: PublicClient,
  row: SignedTxRow,
): Promise<
  { readonly taken: true } | { readonly unanswered: unknown } | { readonly refused: unknown }
> {
  try {
    await client.sendRawTransaction({ serializedTransaction: row.raw as Hex });
    return { taken: true };
  } catch (error) {
    if (unanswered(error)) return { unanswered: error };
    try {
      await client.getTransaction({ hash: row.hash as Hex });
      return { taken: true };
    } catch (lookup) {
      if (!(lookup instanceof TransactionNotFoundError)) return { unanswered: error };
    }
    await conn.transaction(async (within) => {
      await within
        .update(signedTxs)
        .set({ rejectedAt: new Date() })
        .where(eq(signedTxs.id, row.id));
      // A replacement refused leaves the send it would have replaced holding the nonce again.
      if (row.replaces)
        await within
          .update(signedTxs)
          .set({ replacedAt: null })
          .where(eq(signedTxs.id, row.replaces));
    });
    return { refused: error };
  }
}

/** No answer came back at all, so the node may have taken it. */
function unanswered(error: unknown): boolean {
  return (
    !(error instanceof BaseError) ||
    Boolean(
      error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError),
    )
  );
}

async function landed(client: PublicClient, hash: Hex, chain: string): Promise<string> {
  const receipt = await client
    .waitForTransactionReceipt({ hash, timeout: CONFIRM_TIMEOUT_MS })
    .catch((error: unknown) => {
      if (error instanceof WaitForTransactionReceiptTimeoutError)
        throw new Error(
          `The transaction on ${chain} was not confirmed within 3 minutes (${hash}).`,
        );
      throw error;
    });
  if (receipt.status !== "success")
    throw new Error(`The transaction reverted on ${chain} (${hash}).`);
  return hash;
}

/**
 * A journalled send the chain can't answer for yet, with any that replaced it (see replaceStuck):
 * a receipt for any of them says the move landed, with that one's hash. It never will when every
 * one was refused, or when the account's count has passed their nonce with no receipt for any:
 * another transaction took that nonce, say one the same key sent from another wallet. Otherwise
 * the live one goes out again, replaced when it's stuck, and is still on its way.
 */
export async function evmSendStatus(
  row: SignedTxRow,
  account: PrivateKeyAccount | null,
): Promise<{ readonly hash: string } | "pending" | "failed"> {
  const client = evmClient(chainIdOf(row.chain));
  // Counted before the receipts are read, so a nonce passed by one of these shows its receipt.
  const latest = await client.getTransactionCount({
    address: row.address as Address,
    blockTag: "latest",
  });
  const sends = await db
    .select()
    .from(signedTxs)
    .where(
      and(
        eq(signedTxs.actionId, row.actionId),
        eq(signedTxs.chain, row.chain),
        eq(signedTxs.address, row.address),
        eq(signedTxs.nonce, row.nonce!),
      ),
    )
    .orderBy(desc(signedTxs.createdAt));
  for (const sent of sends) {
    const receipt = await client
      .getTransactionReceipt({ hash: sent.hash as Hex })
      .catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
    if (receipt) return { hash: sent.hash };
  }
  if (latest > row.nonce!) return "failed";
  const answer = await inTurn(`evm-send:${row.chain}:${row.address}`, async (conn) => {
    // Read in the turn, as a send there may have replaced it meanwhile.
    const [current] = await conn
      .select()
      .from(signedTxs)
      .where(
        and(
          eq(signedTxs.actionId, row.actionId),
          eq(signedTxs.chain, row.chain),
          eq(signedTxs.address, row.address),
          eq(signedTxs.nonce, row.nonce!),
          live,
        ),
      );
    if (!current) return { refused: "every send of it was refused" };
    return deliverOrReplace(conn, client, account, current);
  });
  return "refused" in answer ? "failed" : "pending";
}
