import {
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/client.ts";
import { actions } from "../../db/schema.ts";
import { signedTxs, type SignedTxRow } from "./tables.ts";
import { solanaRpc, SolanaRpcRefused, waitForSolanaSignature } from "../../money/chains.ts";
import { MayHaveSent, NothingMoved, type KeptTx } from "../../money/recipe.ts";
import type { SignerOptions } from "../../money/wallets.ts";
import type { SolanaKeyPair } from "./keys.ts";

const decoded = (base64Tx: string) =>
  getTransactionDecoder().decode(Buffer.from(base64Tx, "base64"));

/** The blockhash a transaction is good until: past it, it can never land. */
function blockhashOf(base64Tx: string): string {
  const { lifetimeToken } = getCompiledTransactionMessageDecoder().decode(
    decoded(base64Tx).messageBytes,
  );
  return lifetimeToken;
}

async function signatureFound(signature: string): Promise<boolean> {
  const { value } = await solanaRpc<{ value: (object | null)[] }>("getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  return Boolean(value[0]);
}

const resend = (raw: string) =>
  solanaRpc("sendTransaction", [raw, { encoding: "base64", preflightCommitment: "confirmed" }]);

/**
 * Signs a Solana transaction with the local key and sends it exactly as built: any signature
 * someone else made stays. The key pays its own fee and rent, so `paysOwnFee` changes nothing
 * here. The signed bytes are journalled before they go, and it waits until it lands.
 */
export async function sendSolanaTransaction(
  keyPair: SolanaKeyPair,
  owner: string,
  base64Tx: string,
  options: SignerOptions & { readonly setup?: true },
): Promise<string> {
  const signed = await partiallySignTransaction([keyPair], decoded(base64Tx));
  const signature = getSignatureFromTransaction(signed);
  const raw = getBase64EncodedWireTransaction(signed);
  // Journalled and kept on its action as one write, so neither knows a send the other doesn't.
  const { row, kept } = await db.transaction(async (within) => {
    const [row] = await within
      .insert(signedTxs)
      .values({ actionId: options.actionId, chain: "solana", address: owner, raw, hash: signature })
      .returning();
    const kept: KeptTx = {
      chain: "solana",
      hash: signature,
      walletTxId: row!.id,
      ...(options.setup ? { setup: true as const } : {}),
    };
    await options.onSent(kept, within);
    return { row: row!, kept };
  });
  try {
    await resend(raw);
  } catch (error) {
    if (!(error instanceof SolanaRpcRefused)) throw new MayHaveSent(kept, "Solana", error);
    // A node may refuse one it has already processed; one it can't say of may have gone.
    const found = await signatureFound(signature).catch(() => null);
    if (found === null) throw new MayHaveSent(kept, "Solana", error);
    if (found) {
      await waitForSolanaSignature(signature);
      return signature;
    }
    // Journalled as refused, so it is never sent again nor read as landing (solanaSendStatus);
    // the move sent nothing, so Try again can run it once whatever was short is there.
    await db.update(signedTxs).set({ rejectedAt: new Date() }).where(eq(signedTxs.id, row.id));
    throw new NothingMoved(
      `Nothing was sent. ${error.message} This wallet pays its own Solana fees and new accounts' rent, so it needs a little SOL.`,
    );
  }
  await waitForSolanaSignature(signature);
  return signature;
}

/**
 * A journalled Solana send the chain can't answer for yet. Found, it has its hash. Refused, or
 * past its blockhash, it never lands. Otherwise it goes out again and is still on its way.
 */
export async function solanaSendStatus(
  row: SignedTxRow,
): Promise<{ readonly hash: string } | "pending" | "failed"> {
  // Read before its status, so a send that landed while its blockhash was still good is found.
  const { value: valid } = await solanaRpc<{ value: boolean }>("isBlockhashValid", [
    blockhashOf(row.raw),
    { commitment: "confirmed" },
  ]);
  if (await signatureFound(row.hash)) return { hash: row.hash };
  if (row.rejectedAt || !valid) return "failed";
  await resend(row.raw).catch(() => {});
  return "pending";
}

/**
 * Sends again each Solana send journalled for a move still running, while its blockhash is good:
 * the same bytes, so one cut off before it was broadcast can still land (see solanaSendStatus).
 */
export async function resendSolana(): Promise<void> {
  const rows = await db
    .select({ sent: signedTxs })
    .from(signedTxs)
    .innerJoin(actions, eq(actions.id, signedTxs.actionId))
    .where(
      and(
        eq(signedTxs.chain, "solana"),
        eq(actions.status, "running"),
        isNull(signedTxs.rejectedAt),
      ),
    );
  for (const { sent } of rows)
    await solanaSendStatus(sent).catch((error: unknown) =>
      console.error(`Solana send ${sent.hash} not resent`, error),
    );
}
