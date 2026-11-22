import { eq } from "drizzle-orm";
import { isAddressEqual, type Address, type TypedDataDefinition } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";

import { db } from "../../db/client.ts";
import { signedTxs } from "./tables.ts";
import type { Signer } from "../../money/recipe.ts";
import type { SignerOptions } from "../../money/wallets.ts";
import { PrivateFieldRefused } from "../../private-fields.ts";
import {
  NoWallet,
  WalletExists,
  type WalletAddresses,
  type WalletKeys,
  type WalletProvider,
} from "../contract.ts";
import {
  BRING_INPUTS,
  broughtKeys,
  solanaAlone,
  GOES_TO_WALLET,
  notes,
  preview,
  SOLANA_INPUTS,
  SOLANA_NOTES,
} from "./bring.ts";
import { asSent, DELEGATION_MANAGER, evmSendStatus, resendEvm, sendEvmTransaction } from "./evm.ts";
import {
  addressesOf,
  generateKeys,
  machineKeyStore,
  solanaKeyPair,
  withKeysLocked,
  type KeyStore,
  type SolanaKeyPair,
} from "./keys.ts";
import { resendSolana, sendSolanaTransaction, solanaSendStatus } from "./solana.ts";

interface Held {
  readonly keys: WalletKeys;
  readonly evm: PrivateKeyAccount | null;
  readonly solana: { readonly keyPair: SolanaKeyPair; readonly address: string } | null;
}

const ALREADY = "Auni holds a wallet here already, so nothing changed.";
const NOT_EVM_ALONE =
  "This wallet doesn't hold an EVM key alone, so a Solana key can't be added to it. Nothing changed.";

/** The wallet that signs with the owner's keys in `store`, once the owner makes or brings them. */
export function localKeyWalletIn(store: KeyStore): WalletProvider {
  // Keys are only ever added, so once found or made they're held here, and the store isn't read
  // again, as the background jobs ask for the addresses each minute: the OS keychain neither
  // prompts each time nor stops those jobs when it locks while the keys are held. Until then it
  // is read on each ask, since another process on this database may make them.
  let held: Promise<Held> | undefined;
  const current = async (): Promise<Held | null> => {
    if (held) return held;
    const keys = await store.read();
    if (!keys) return null;
    held ??= holding(keys);
    return held;
  };
  const wallet = async (): Promise<Held> => {
    const found = await current();
    if (!found) throw new NoWallet();
    return found;
  };

  /** Writes `keys` as the owner's, unless some are there already, and holds them. */
  const keep = (keys: WalletKeys, refused: () => Error) =>
    withKeysLocked(async () => {
      if (await store.read()) throw refused();
      await store.write(keys);
      held = holding(keys);
      return held;
    });

  /**
   * Adds the key the kept ones lack, as `lacking` makes it from them, under the keys' lock, and
   * holds them all: `lacking` throws for keys it won't add to, and KeyStore.add refuses any that
   * would change a key kept.
   */
  const add = (lacking: (kept: WalletKeys | null) => Promise<WalletKeys>) =>
    withKeysLocked(async () => {
      const keys = await lacking(await store.read());
      await store.add(keys);
      held = holding(keys);
      return held;
    });

  return {
    byDefault: true,
    addresses: async () => addressesHeld(await current()),
    create: async () => addressesHeld(await keep(await generateKeys(), () => new WalletExists())),
    bring: {
      id: "wallet-keys",
      label: "Wallet keys",
      goes: GOES_TO_WALLET,
      app: "local-key",
      link: null,
      confirms: true,
      proof: false,
      inputs: BRING_INPUTS,
      async check(values) {
        if (await current()) throw new PrivateFieldRefused(ALREADY);
        const { addresses } = await broughtKeys(values);
        return { preview: preview(addresses), notes: await notes(addresses) };
      },
      async accept(values) {
        const { keys } = await broughtKeys(values);
        await keep(keys, () => new PrivateFieldRefused(ALREADY));
        return null;
      },
    },
    bringSolana: {
      label: "Solana private key",
      goes: GOES_TO_WALLET,
      app: "local-key",
      link: null,
      confirms: true,
      inputs: SOLANA_INPUTS,
      async check(values) {
        const found = await current();
        if (!found?.evm || found.solana) throw new PrivateFieldRefused(NOT_EVM_ALONE);
        const { addresses } = await solanaAlone(values);
        return { preview: preview(addresses), notes: SOLANA_NOTES };
      },
      async accept(values) {
        const { keys } = await solanaAlone(values);
        await add(async (kept) => {
          if (!kept?.evm || kept.solana) throw new PrivateFieldRefused(NOT_EVM_ALONE);
          return { evm: kept.evm, solana: keys.solana };
        });
        return null;
      },
    },
    // The key a wallet brought with one alone lacks, made here as a new wallet's are.
    addMissing: async () =>
      addressesHeld(
        await add(async (kept) => {
          if (!kept) throw new NoWallet();
          if (kept.evm && kept.solana) throw new WalletExists();
          const made = await generateKeys();
          return { evm: kept.evm ?? made.evm, solana: kept.solana ?? made.solana };
        }),
      ),
    // No sponsor: the key pays its own gas everywhere, Solana's fees and rent included.
    signer: async (options) => signer(await wallet(), options),
    asSent,
    async sendStatus(walletTxId) {
      // An id this wallet never journalled (another wallet's) is no send it can answer for.
      if (!z.uuid().safeParse(walletTxId).success) return "pending";
      const [row] = await db.select().from(signedTxs).where(eq(signedTxs.id, walletTxId));
      if (!row) return "pending";
      return row.chain === "solana"
        ? solanaSendStatus(row)
        : evmSendStatus(row, (await current())?.evm ?? null);
    },
    async resend() {
      await resendEvm((await current())?.evm ?? null);
      await resendSolana();
    },
    revealKeys: async () => (await wallet()).keys,
    keptHere: {
      where: () => store.where(),
      async remove() {
        await store.remove();
        held = undefined;
      },
      keep: async (keys) => void (await keep(keys, () => new WalletExists())),
    },
  };
}

const addressesHeld = (held: Held | null): WalletAddresses => ({
  evm: held?.evm?.address ?? null,
  solana: held?.solana?.address ?? null,
});

async function holding(keys: WalletKeys): Promise<Held> {
  const evm = keys.evm ? privateKeyToAccount(keys.evm as `0x${string}`) : null;
  const addresses = await addressesOf(keys);
  const solana =
    keys.solana && addresses.solana
      ? { keyPair: await solanaKeyPair(keys.solana), address: addresses.solana }
      : null;
  return { keys, evm, solana };
}

function signer({ evm, solana }: Held, options: SignerOptions): Signer {
  const evmKey = () => {
    if (!evm) throw new Error("This wallet holds no EVM key, so nothing was sent.");
    return evm;
  };
  return {
    evmAddress: evm?.address ?? "",
    solanaAddress: solana?.address ?? "",

    sendEvmTransaction: (chainId, tx) =>
      sendEvmTransaction(evmKey(), chainId, "to" in tx ? [tx] : tx, options),

    async signEvmTypedData(document) {
      const account = evmKey();
      // The account's own code (the DeleGator) and its delegation manager take the key's
      // signature as leave to move anything: no venue's document is one of those.
      const verifier = document.domain.verifyingContract;
      if (
        typeof verifier === "string" &&
        [account.address, DELEGATION_MANAGER].some((each) =>
          isAddressEqual(each, verifier as Address),
        )
      )
        throw new Error("Auni won't sign this: it would let someone act as the wallet itself.");
      return account.signTypedData(document as TypedDataDefinition);
    },

    sendSolanaTransaction(base64Tx, { setup } = {}) {
      if (!solana) throw new Error("This wallet holds no Solana key, so nothing was sent.");
      return sendSolanaTransaction(solana.keyPair, solana.address, base64Tx, {
        ...options,
        ...(setup ? { setup } : {}),
      });
    },
  };
}

/** The owner's keys on this machine (see keys.ts), signed with in this process. */
export const localKeyWallet = localKeyWalletIn(machineKeyStore());
