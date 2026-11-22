import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Blockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../db/client.ts";
import { actions } from "../../db/schema.ts";
import { signedTxs } from "./tables.ts";
import { solanaRpc, SolanaRpcRefused } from "../../money/chains.ts";
import { MayHaveSent, NothingMoved, type KeptTx } from "../../money/recipe.ts";
import { failureKind } from "../../money/failure.ts";
import { insertAction, wipe } from "../../test/db.ts";
import { sendSolanaTransaction, solanaSendStatus } from "./solana.ts";

vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original()),
  solanaRpc: vi.fn(),
  waitForSolanaSignature: async () => {},
}));

/** Solana's answers, by method, for what a test says the chain holds. */
function solana({
  found = false,
  valid = true,
  send = "taken",
}: {
  readonly found?: boolean;
  readonly valid?: boolean;
  readonly send?: "taken" | "refused" | "no answer";
} = {}) {
  const sent: string[] = [];
  vi.mocked(solanaRpc).mockImplementation(async (method: string, params: unknown[]) => {
    switch (method) {
      case "sendTransaction":
        sent.push(params[0] as string);
        if (send === "refused")
          throw new SolanaRpcRefused("Solana RPC sendTransaction failed: insufficient funds.");
        if (send === "no answer") throw new TypeError("fetch failed");
        return "signature";
      case "getSignatureStatuses":
        return { value: [found ? { err: null, confirmationStatus: "confirmed" } : null] } as never;
      case "isBlockhashValid":
        return { value: valid } as never;
      default:
        throw new Error(`No answer for ${method}.`);
    }
  });
  return sent;
}

const wallet = await generateKeyPair();
const owner = await getAddressFromPublicKey(wallet.publicKey);
const payer = await generateKeyPair();
const payerAddress = await getAddressFromPublicKey(payer.publicKey);

/** A transaction someone else pays for and has signed, which the wallet must sign too. */
async function theirs(): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(payerAddress, draft),
    (draft) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n },
        draft,
      ),
    (draft) =>
      appendTransactionMessageInstruction(
        {
          programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          accounts: [{ address: owner, role: AccountRole.READONLY_SIGNER }],
        },
        draft,
      ),
  );
  const signed = await partiallySignTransaction([payer], compileTransaction(message));
  return getBase64EncodedWireTransaction(signed);
}

beforeEach(() => wipe(actions, signedTxs));

const kept: KeptTx[] = [];
let actionId = "";
beforeEach(async () => {
  actionId = (await insertAction()).id;
  kept.length = 0;
});
const options = () => ({ actionId, attempt: 1, onSent: async (tx: KeptTx) => void kept.push(tx) });
const journalled = () => db.select().from(signedTxs);

describe("sendSolanaTransaction", () => {
  it("signs beside the signature someone else made, journals it, and sends it as built", async () => {
    const sent = solana();
    const signature = await sendSolanaTransaction(wallet, owner, await theirs(), {
      ...options(),
      setup: true,
    });

    const [row] = await journalled();
    expect(row).toMatchObject({ chain: "solana", nonce: null, hash: signature, raw: sent[0] });
    expect(kept).toEqual([{ chain: "solana", hash: signature, walletTxId: row!.id, setup: true }]);
    const { messageBytes, signatures } = getTransactionDecoder().decode(
      Buffer.from(sent[0]!, "base64"),
    );
    // The fee payer's signature is the transaction's id, and both still check.
    expect(signature).toBe(signatureOf(signatures, payerAddress));
    for (const [signer, key] of [
      [payerAddress, payer],
      [owner, wallet],
    ] as const)
      expect(await verifySignature(key.publicKey, signatures[signer]!, messageBytes)).toBe(true);
  });

  it("says a send no node answered may have gone", async () => {
    solana({ send: "no answer" });
    await expect(
      sendSolanaTransaction(wallet, owner, await theirs(), options()),
    ).rejects.toBeInstanceOf(MayHaveSent);
    expect((await journalled())[0]!.rejectedAt).toBeNull();
  });

  it("marks one Solana refused, and says the wallet pays its own fees", async () => {
    solana({ send: "refused" });
    const refused = sendSolanaTransaction(wallet, owner, await theirs(), options());
    await expect(refused).rejects.toThrow(
      /^Nothing was sent\. .*insufficient funds.*it needs a little SOL\.$/u,
    );
    // Nothing moved, so the move can run again once the SOL is there: never read as short of
    // money for good, though the node's words say "insufficient funds".
    await expect(refused).rejects.toBeInstanceOf(NothingMoved);
    expect(failureKind(await refused.catch((error: unknown) => error))).toBe("unfilled");
    expect((await journalled())[0]!.rejectedAt).not.toBeNull();
    // And never sent again, nor read as on its way.
    expect(await solanaSendStatus((await journalled())[0]!)).toBe("failed");
  });

  it("sends nothing when its action can't keep it, since the journal writes with it", async () => {
    const sent = solana();
    await expect(
      sendSolanaTransaction(wallet, owner, await theirs(), {
        ...options(),
        onSent: async () => {
          throw new Error("The database went away.");
        },
      }),
    ).rejects.toThrow("The database went away.");
    expect(await journalled()).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("solanaSendStatus", () => {
  const journal = async () => {
    solana({ send: "no answer" });
    await sendSolanaTransaction(wallet, owner, await theirs(), options()).catch(() => {});
    return (await journalled())[0]!;
  };

  it("gives its signature once Solana has it", async () => {
    const row = await journal();
    solana({ found: true });
    expect(await solanaSendStatus(row)).toEqual({ hash: row.hash });
  });

  it("sends the same bytes again while its blockhash is still good", async () => {
    const row = await journal();
    const sent = solana();
    expect(await solanaSendStatus(row)).toBe("pending");
    expect(sent).toEqual([row.raw]);
  });

  it("says it failed once its blockhash expired, and sends nothing", async () => {
    const row = await journal();
    const sent = solana({ valid: false });
    expect(await solanaSendStatus(row)).toBe("failed");
    expect(sent).toEqual([]);
  });
});

function signatureOf(signatures: Record<string, Uint8Array | null>, signer: string): string {
  const bytes = signatures[signer];
  if (!bytes) throw new Error(`${signer} hasn't signed.`);
  return getBase58Decoder().decode(bytes);
}
