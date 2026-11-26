import { keccak256, toHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { chainKey } from "../money/chains.ts";
import type { EvmTx } from "../money/recipe.ts";
import { WalletExists, type WalletProvider } from "../apps/contract.ts";
import { PrivateFieldRefused } from "../private-fields.ts";
import { chains } from "./world/chain.ts";

// The demo's wallet: a wallet app like any other (apps/wallet.md) that reaches no key the
// owner holds and no chain. A send goes to the demo's own ledger (world/chain.ts), which mines
// it at once, so a move plays through to done with nothing signed for a real network.

/**
 * The key the demo wallet signs with. It is printed here for anyone to read, so its address is
 * nobody's wallet: never send it money. A venue's order is signed with it only so core's own
 * check passes, that a signature recovers to the wallet (money/typed-data.ts).
 */
const PUBLISHED_KEY: Hex = keccak256(toHex("auni demo wallet: this key is public"));
const account = privateKeyToAccount(PUBLISHED_KEY);

/** The demo owner's addresses. The Solana one has no key at all. */
export const WALLET = {
  evm: account.address,
  solana: "AuniDemo111111111111111111111111111111111111",
} as const;

/**
 * `auni demo --first-run --no-wallet`: there's no wallet yet, as a new owner who didn't bring one
 * meets first run, and their first take's chat makes it. Otherwise the demo starts with its wallet
 * made, as an owner past first run has.
 */
const wallet = { made: true };

export function startWithoutWallet(): void {
  wallet.made = false;
}

/** The demo reads nothing of the owner's, so its field to bring a wallet takes no keys. */
const TAKES_NO_KEYS = "This is the demo, so it takes no keys: its wallet is made up. Nothing was saved.";

export const demoWallet: WalletProvider = {
  addresses: async () => (wallet.made ? WALLET : { evm: null, solana: null }),
  create: async () => {
    if (wallet.made) throw new WalletExists();
    wallet.made = true;
    return WALLET;
  },
  bring: {
    id: "wallet-keys",
    label: "Wallet keys",
    goes: "It goes straight to Auni's wallet on this computer. Auni's AI never sees it.",
    app: "demo-wallet",
    link: null,
    confirms: true,
    proof: false,
    inputs: [{ name: "keys", label: "Your keys", placeholder: "Paste your keys", set: false }],
    check: () => Promise.reject(new PrivateFieldRefused(TAKES_NO_KEYS)),
    accept: () => Promise.reject(new PrivateFieldRefused(TAKES_NO_KEYS)),
  },
  // The demo's chains ask no fee, so no move waits on the chain's coin.
  sponsored: () => true,
  signer: async ({ onSent }) => ({
    evmAddress: WALLET.evm,
    solanaAddress: WALLET.solana,
    async sendEvmTransaction(chainId, tx) {
      const txs: readonly EvmTx[] = "to" in tx ? [tx] : tx;
      const chain = [...chains.values()].find(({ id }) => id === chainId);
      if (!chain) throw new Error(`The demo has no chain ${chainId}, so nothing was sent.`);
      const hash = chain.send(
        WALLET.evm,
        txs.map(({ to, data, value }) => ({
          to: to as Address,
          data: (data ?? "0x") as Hex,
          value: BigInt(value ?? 0),
        })),
      );
      await onSent({
        chain: chainKey(chainId),
        hash,
        ...(txs.every(({ setup }) => setup) ? { setup: true as const } : {}),
      });
      return hash;
    },
    signEvmTypedData: (document) => account.signTypedData(document as TypedDataDefinition),
    sendSolanaTransaction: () =>
      Promise.reject(new Error("The demo sends nothing on Solana, so nothing was sent.")),
  }),
  // Every send is mined as it is handed over, so none is ever left for the wallet to answer for.
  sendStatus: async () => "pending",
  // Its key is printed above for anyone to read, so showing it (first run's spare key) shows nobody's.
  revealKeys: async () => ({ evm: PUBLISHED_KEY, solana: null }),
};
