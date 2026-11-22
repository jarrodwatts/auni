import type { Hex, TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { EvmTx, Signer } from "../money/recipe.ts";
import type { TypedData } from "../money/typed-data.ts";

/** Wallets backed by a local key: signs exactly the JSON document the real wallet receives, sends nothing. */
export function walletsFor(key: Hex, reportedAddress?: string): Signer {
  const account = privateKeyToAccount(key);
  return {
    evmAddress: reportedAddress ?? account.address,
    solanaAddress: "",
    signEvmTypedData: (typedData) => account.signTypedData(typedData as TypedDataDefinition),
    sendEvmTransaction: () => Promise.reject(new Error("not in this test")),
    sendSolanaTransaction: () => Promise.reject(new Error("not in this test")),
  };
}

// A throwaway key, so what the recording wallet signs recovers to its address as a real one's does.
const OWNER_KEY: Hex = `0x${"42".repeat(32)}`;

/** The owner's wallets in a test that records what a recipe signs (see recordingWallets). */
export const OWNER = {
  evm: privateKeyToAccount(OWNER_KEY).address,
  solana: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
} as const;

/** Everything a recipe handed the wallet to sign or send, in order. */
export interface Signed {
  readonly evm: { readonly chainId: number; readonly txs: readonly EvmTx[] }[];
  readonly solana: { readonly base64Tx: string; readonly setup: boolean }[];
  readonly typed: TypedData[];
}

/** How many things the wallet was asked to sign or send. */
export const signedCount = (signed: Signed) =>
  signed.evm.length + signed.solana.length + signed.typed.length;

/**
 * The owner's wallets (OWNER) as a recorder: each send is kept in `signed` and answered with a
 * made-up hash, and typed data is really signed, so a recipe that checks the signature recovers
 * to the wallet goes on as it would.
 */
export function recordingWallets(): Signer & { readonly signed: Signed } {
  const account = privateKeyToAccount(OWNER_KEY);
  const signed: Signed = { evm: [], solana: [], typed: [] };
  const sends = () => signedCount(signed);
  return {
    signed,
    evmAddress: OWNER.evm,
    solanaAddress: OWNER.solana,
    async sendEvmTransaction(chainId, tx) {
      signed.evm.push({ chainId, txs: Array.isArray(tx) ? tx : [tx as EvmTx] });
      return `0x${sends().toString(16).padStart(64, "0")}`;
    },
    async sendSolanaTransaction(base64Tx, options) {
      signed.solana.push({ base64Tx, setup: options?.setup === true });
      return `${sends()}`.padStart(88, "1");
    },
    async signEvmTypedData(typedData) {
      signed.typed.push(typedData);
      return account.signTypedData(typedData as TypedDataDefinition);
    },
  };
}
