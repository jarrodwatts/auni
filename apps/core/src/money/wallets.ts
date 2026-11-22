import { SOLANA_BRING_FIELD } from "@auni/shared";
import type { Address } from "viem";

import type { Tx } from "../db/client.ts";
import { WalletExists, type WalletAddresses, type WalletKeys } from "../apps/contract.ts";
import type { PrivateField } from "../private-fields.ts";
import type { EvmSend, EvmTx, KeptTx, Reach, Signer } from "./recipe.ts";

// Apps read addresses from this file, and loading an app never loads the registry (which
// loads every app; apps.test.ts checks it), so the wallet is looked up when first asked for.
const theWallet = async () => (await import("../apps/registry.ts")).theWallet();

export interface SignerOptions {
  readonly actionId: string;
  /** Which run of the action this is (see retry.ts): each run sends under keys of its own. */
  readonly attempt: number;
  /**
   * Keeps a send on its action. A wallet that journals its sends passes the database
   * transaction its journal writes in as `within`, so the two commit together or not at all:
   * a crash can't leave a send its journal will send again that its action knows nothing of.
   * Then a write that fails throws, and nothing is sent.
   */
  readonly onSent: (tx: KeptTx, within?: Tx) => Promise<void>;
}

/**
 * The owner's addresses, as the wallet app (see WALLET) holds them: both null until the owner
 * makes or brings a wallet in setup.
 */
export async function walletAddresses(): Promise<WalletAddresses> {
  return (await theWallet()).addresses();
}

/** Whether there is a wallet yet, which background work that reads it waits for. */
export async function hasWallet(): Promise<boolean> {
  const { evm, solana } = await walletAddresses();
  return evm !== null || solana !== null;
}

/** Makes the owner's wallet, once: WalletExists when there is one. */
export async function createWallet(): Promise<WalletAddresses> {
  return (await theWallet()).create();
}

/**
 * What the wallet can move on now: everywhere but Solana for one that holds an EVM key and no
 * Solana key. Read as everywhere while there's no wallet or it can't be read, which changes nothing.
 */
export async function walletReach(): Promise<Reach> {
  return reachOf(await walletAddresses().catch(() => null));
}

/** What a wallet with these addresses can move on (see walletReach); null where unread. */
export function reachOf(wallet: WalletAddresses | null): Reach {
  return { solana: !wallet?.evm || wallet.solana !== null };
}

/** The network whose address the wallet can make beside the one it holds, or null (see addMissing). */
export async function missingAddress(): Promise<"evm" | "solana" | null> {
  const wallet = await theWallet();
  if (!wallet.addMissing) return null;
  const { evm, solana } = await wallet.addresses();
  return evm && !solana ? "solana" : solana && !evm ? "evm" : null;
}

/** Makes the key the wallet lacks beside the one it holds: WalletExists when it can't. */
export async function addMissingKey(): Promise<WalletAddresses> {
  const wallet = await theWallet();
  if (!wallet.addMissing) throw new WalletExists();
  return wallet.addMissing();
}

/**
 * Why the wallet takes no Solana key the owner already holds now, in their words; null while it
 * does: it holds an EVM key alone, and is a wallet that can take one.
 */
export async function noSolanaBring(): Promise<string | null> {
  const { walletApp } = await import("../apps/registry.ts");
  const { about, provided } = walletApp();
  if (!provided.bringSolana)
    return `${about.name} makes its own keys, so it can't take a Solana key you already hold.`;
  const { evm, solana } = await provided.addresses();
  if (solana) return "This wallet holds a Solana key already, and a key is only ever added.";
  if (!evm) return "There's no wallet yet: bring your keys as you start, from Had Auni at auni.io?";
  return null;
}

/**
 * The wallet's private fields core takes now: the keys to bring while there is no wallet, and a
 * Solana key the owner holds while the wallet holds an EVM key alone. Bringing that one takes
 * proof the owner is there, whoever makes the wallet: a key pasted from an unlocked laptop, or
 * swapped by a script in its browser, could be someone else's, who would then hold every coin
 * later sent or bridged to the wallet's Solana address. Once it is in, the sweep reads what it
 * already holds.
 */
export async function walletFields(): Promise<PrivateField[]> {
  const wallet = await theWallet();
  const solana = wallet.bringSolana;
  return [
    ...(wallet.bring ? [wallet.bring] : []),
    ...(solana && (await noSolanaBring()) === null
      ? [
          {
            ...solana,
            id: SOLANA_BRING_FIELD,
            proof: true,
            async accept(values) {
              const said = await solana.accept(values);
              void import("./sweep.ts")
                .then(({ sweepArrivals }) => sweepArrivals())
                .catch((error: unknown) => console.error("arrivals sweep failed", error));
              return said;
            },
          } satisfies PrivateField,
        ]
      : []),
  ];
}

/** The owner's private keys, shown only behind the owner's proof (auth/proof.ts); throws with no wallet. */
export async function revealWalletKeys(): Promise<WalletKeys> {
  return (await theWallet()).revealKeys();
}

/**
 * The EVM address a recipe reads balances and approvals from before anything
 * is signed, or null while the wallet holds no EVM key: then it holds nothing
 * there and has approved nothing.
 */
export async function evmAddress(): Promise<string | null> {
  return (await walletAddresses()).evm;
}

/**
 * What a move says on a network the wallet holds no key for, as the agent and the owner read it:
 * a wallet brought with one key alone has no address on the other's networks until one is made
 * in Settings (addMissingKey).
 */
export function noAddressOn(network: "Solana" | "EVM"): string {
  const there = network === "Solana" ? "on Solana" : "on an EVM network";
  return `This wallet has no ${network} address yet, so nothing can move ${there}. One can be added in Settings, under Wallet.`;
}

/** The Solana address a recipe reads balances from before anything is signed, or null as above. */
export async function solanaAddress(): Promise<string | null> {
  return (await walletAddresses()).solana;
}

/**
 * Signs for the owner's wallets. Every send waits until the transaction lands,
 * so a recipe can chain an approve into the call that spends it.
 */
export async function signerFor(options: SignerOptions): Promise<Signer> {
  return (await theWallet()).signer(options);
}

/**
 * No sponsor pays the fees on this chain (an EVM chain's id, or Solana), so the wallet pays its
 * own in the chain's coin, and on Solana the rent of what a move opens.
 */
export async function paysOwnGas(chain: number | "solana"): Promise<boolean> {
  return !(await theWallet()).sponsored?.(chain);
}

/**
 * The one transaction the wallet would send for these EVM calls from `owner`, said with nothing
 * signed, so gas.ts can ask the chain what it costs; null when the wallet doesn't say.
 */
export async function asSent(
  chainId: number,
  owner: Address,
  txs: readonly EvmTx[],
): Promise<EvmSend | null> {
  return (await (await theWallet()).asSent?.(chainId, owner, txs)) ?? null;
}
