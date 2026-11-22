import { createPrivateKey, createPublicKey } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { SOLANA_CAIP2 } from "@auni/shared";
import { APIError } from "@privy-io/node";
import type { Address } from "viem";

import { requiredSetting } from "../../settings.ts";
import { batchCall, delegateOf, plainCall } from "../../money/account-code.ts";
import { chainKey, evmClient, waitForSolanaSignature } from "../../money/chains.ts";
import {
  MayHaveSent,
  type EvmSend,
  type EvmTx,
  type KeptTx,
  type Signer,
} from "../../money/recipe.ts";
import { assertOwnGas, ownGasFees } from "../../money/gas.ts";
import type { SignerOptions } from "../../money/wallets.ts";
import {
  NoWallet,
  WalletExists,
  type WalletAddresses,
  type WalletKeys,
  type WalletProvider,
} from "../contract.ts";
import { privyClient } from "./client.ts";
import about from "./about.ts";

/** Privy's names for Auni's two server wallets in the owner's app, which find them again. */
const EXTERNAL_IDS = { ethereum: "auni-evm", solana: "auni-solana" } as const;

interface ServerWallet {
  readonly id: string;
  readonly address: string;
}

function authorizationKey(): string {
  return requiredSetting(about, "authorizationKey");
}

function authorizationContext() {
  return { authorization_private_keys: [authorizationKey()] };
}

/** The authorization key's public half, as Privy names a wallet's owner: base64 DER (SPKI). */
function ownerPublicKey(): string {
  const pkcs8 = Buffer.from(authorizationKey().replace(/^wallet-auth:/u, ""), "base64");
  // The private key's JWK without its secret `d` is the public key.
  const { kty, crv, x, y } = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }).export({
    format: "jwk",
  });
  return createPublicKey({ key: { kty, crv, x, y }, format: "jwk" })
    .export({ format: "der", type: "spki" })
    .toString("base64");
}

/** The app's wallet of this kind, found by its external id; null until it's made. */
async function findWallet(chainType: keyof typeof EXTERNAL_IDS): Promise<ServerWallet | null> {
  const { data } = await privyClient().wallets().list({ external_id: EXTERNAL_IDS[chainType] });
  const found = data.find((wallet) => wallet.chain_type === chainType);
  return found ? { id: found.id, address: found.address } : null;
}

/**
 * Makes the app's wallet of this kind, owned by the authorization key so nothing else in the
 * app can sign for it. Its external id is the idempotency key, so two asks at once make one.
 */
async function makeWallet(chainType: keyof typeof EXTERNAL_IDS): Promise<ServerWallet> {
  const externalId = EXTERNAL_IDS[chainType];
  const made = await privyClient()
    .wallets()
    .create({
      chain_type: chainType,
      external_id: externalId,
      owner: { public_key: ownerPublicKey() },
      idempotency_key: externalId,
    });
  return { id: made.id, address: made.address };
}

interface ServerWallets {
  readonly evm: ServerWallet;
  readonly solana: ServerWallet;
}

// A wallet's id and address never change once made, so they're read once per process once found.
let found: Promise<ServerWallets> | undefined;

/** Auni's two wallets in the app, or null until the owner makes them. */
async function serverWallets(): Promise<ServerWallets | null> {
  if (found) return found;
  const [evm, solana] = await Promise.all([findWallet("ethereum"), findWallet("solana")]);
  if (!evm || !solana) return null;
  found ??= Promise.resolve({ evm, solana });
  return found;
}

async function theWallets(): Promise<ServerWallets> {
  const wallets = await serverWallets();
  if (!wallets) throw new NoWallet();
  return wallets;
}

async function addresses(): Promise<WalletAddresses> {
  const wallets = await serverWallets();
  return { evm: wallets?.evm.address ?? null, solana: wallets?.solana.address ?? null };
}

/** Makes both wallets, once: one left half-made by an earlier try is finished. */
async function create(): Promise<WalletAddresses> {
  if (await serverWallets()) throw new WalletExists();
  const [evm, solana] = await Promise.all([
    findWallet("ethereum").then((wallet) => wallet ?? makeWallet("ethereum")),
    findWallet("solana").then((wallet) => wallet ?? makeWallet("solana")),
  ]);
  found = Promise.resolve({ evm, solana });
  return { evm: evm.address, solana: solana.address };
}

/**
 * Privy sponsors gas through EIP-7702 everywhere its dashboard lists, which Ethereum never is,
 * and Solana's fees and rent through its fee payer.
 */
const sponsored = (chain: number | "solana"): boolean => chain !== 1;

/**
 * The account code Privy puts a wallet under to send a list as one transaction: a wallet Privy
 * held ran it on each of the seven chains where it ran any (read on chain, November 2026), and
 * it takes ERC-7579's batch from the account itself.
 */
const PRIVY_ACCOUNT: Address = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28";

/**
 * The one transaction the wallet pays for these calls with, as near as Auni can say with
 * nothing signed: one call goes as built (see `tipped`). A list is Privy's to build and its docs
 * don't say how, so it is costed as the batch its account code takes, under the code the address
 * runs already or, with none yet, the code Privy would put it under.
 */
async function asSent(
  chainId: number,
  owner: Address,
  txs: readonly EvmTx[],
): Promise<EvmSend | null> {
  const [only, ...more] = txs;
  if (only && more.length === 0) return plainCall(only);
  const delegated = delegateOf(await evmClient(chainId).getCode({ address: owner }));
  return { ...batchCall(owner, txs), ...(delegated ? {} : { delegates: PRIVY_ACCOUNT }) };
}

const CONFIRM_TIMEOUT_MS = 180_000;
const POLL_MS = 1_500;

/**
 * Signs through Privy with the authorization key that owns the app's server
 * wallets. Every send waits until the transaction lands, so a recipe can
 * chain an approve into the call that spends it.
 */
async function signer(options: SignerOptions): Promise<Signer> {
  const { evm, solana } = await theWallets();
  let sequence = 0;
  // Privy dedupes on this key, so a client-level retry never sends twice. It
  // names the run, so a step tried again never sends under a key an earlier
  // run used, which Privy would take for that earlier send.
  const idempotencyKey = () => `${options.actionId}:a${options.attempt}:${sequence++}`;

  return {
    evmAddress: evm.address,
    solanaAddress: solana.address,

    async sendEvmTransaction(chainId: number, tx: EvmTx | readonly EvmTx[]): Promise<string> {
      const txs = "to" in tx ? [tx] : tx;
      const walletId = evm.id;
      const chain = chainKey(chainId);
      const kept = (sent: readonly EvmTx[]) => ({
        chain,
        ...(sent.every((each) => each.setup) ? { setup: true as const } : {}),
      });
      // Kept before it has a hash: if none ever comes back, it still went out.
      const land = async (walletTxId: string, sent: readonly EvmTx[]) => {
        await options.onSent({ ...kept(sent), walletTxId });
        return waitForPrivyTransaction(walletTxId, chain, (hash) =>
          options.onSent({ ...kept(sent), walletTxId, hash }),
        );
      };
      // One transaction for the whole list: if any call reverts, none of it happened.
      const batch = async (sponsor: boolean) => {
        const sent = await submitted(
          kept(txs),
          privyClient()
            .wallets()
            .ethereum()
            .sendCalls(walletId, {
              caip2: `eip155:${chainId}`,
              params: {
                calls: txs.map((each) => ({
                  to: each.to,
                  ...(each.data ? { data: each.data as `0x${string}` } : {}),
                  value: hexOf(BigInt(each.value ?? "0")),
                })),
              },
              sponsor,
              idempotency_key: idempotencyKey(),
              authorization_context: authorizationContext(),
            }),
        );
        return land(sent.transaction_id, txs);
      };
      // One call the wallet pays for goes as a plain transaction, so it can carry a tip:
      // Privy's batches offer none, which builders pass over once blocks fill.
      const tipped = async (each: EvmTx) => {
        const fees = await ownGasFees(chainId).catch(() => null);
        const sent = await submitted(
          kept([each]),
          privyClient()
            .wallets()
            .ethereum()
            .sendTransaction(walletId, {
              caip2: `eip155:${chainId}`,
              params: {
                transaction: {
                  to: each.to,
                  ...(each.data ? { data: each.data as `0x${string}` } : {}),
                  value: hexOf(BigInt(each.value ?? "0")),
                  ...(fees
                    ? {
                        type: 2 as const,
                        max_fee_per_gas: hexOf(fees.maxFee),
                        max_priority_fee_per_gas: hexOf(fees.tip),
                      }
                    : {}),
                },
              },
              idempotency_key: idempotencyKey(),
              authorization_context: authorizationContext(),
            }),
        );
        // It went out, so it is kept by its hash, and its receipt settles it.
        if (!sent.transaction_id)
          throw new MayHaveSent({ ...kept([each]), hash: sent.hash }, "Privy", "no transaction id");
        return land(sent.transaction_id, [each]);
      };
      // The wallet pays in the chain's own coin; a list still goes as one transaction, since
      // its card judged it as one.
      const own = async () => {
        // Where the wallet pays, nothing goes out that it can't cover.
        await assertOwnGas(chainId, evm.address as Address, txs);
        return txs.length === 1 ? tipped(txs[0]!) : batch(false);
      };
      // Privy sponsors gas through EIP-7702 on the chains its dashboard lists; anywhere the
      // owner's app hasn't turned it on, the wallet pays.
      return !sponsored(chainId)
        ? own()
        : batch(true).catch((error: unknown) => {
            if (!String(error).includes("Gas sponsorship is not configured")) throw error;
            return own();
          });
    },

    async signEvmTypedData({ domain, types, primaryType, message }): Promise<string> {
      const signed = await privyClient()
        .wallets()
        .ethereum()
        .signTypedData(evm.id, {
          params: {
            typed_data: {
              domain,
              // Privy's types are mutable arrays; it only reads them.
              types: types as Record<string, { name: string; type: string }[]>,
              message,
              primary_type: primaryType,
            },
          },
          authorization_context: authorizationContext(),
        });
      return signed.signature;
    },

    async sendSolanaTransaction(base64Tx: string, { setup, paysOwnFee } = {}): Promise<string> {
      const kept = { chain: "solana", ...(setup ? { setup } : {}) };
      const sent = await submitted(
        kept,
        privyClient().wallets().solana().signAndSendTransaction(solana.id, {
          caip2: SOLANA_CAIP2,
          transaction: base64Tx,
          // Privy's sponsorship swaps in its own fee payer and covers fees and new-account rent.
          sponsor: !paysOwnFee,
          idempotency_key: idempotencyKey(),
          authorization_context: authorizationContext(),
        }),
      );
      await options.onSent({ ...kept, hash: sent.hash });
      await waitForSolanaSignature(sent.hash);
      return sent.hash;
    },
  };
}

/** A send kept by its Privy transaction id, as Privy tells it now. */
async function sendStatus(id: string): Promise<{ readonly hash: string } | "pending" | "failed"> {
  const found = await privyClient().transactions().get(id);
  if (found.transaction_hash) return { hash: found.transaction_hash };
  // Failed is Privy's word that it will never land; anything else may still.
  return found.status === "failed" ? "failed" : "pending";
}

async function revealKeys(): Promise<WalletKeys> {
  const { evm, solana } = await theWallets();
  const exported = (wallet: ServerWallet) =>
    privyClient()
      .wallets()
      .exportPrivateKey(wallet.id, { authorization_context: authorizationContext() })
      .then(({ private_key }) => private_key);
  const [evmKey, solanaKey] = await Promise.all([exported(evm), exported(solana)]);
  return { evm: evmKey, solana: solanaKey };
}

/**
 * Two server wallets in the owner's own Privy app (PRIVY_APP_ID), owned by
 * their authorization key (PRIVY_AUTHORIZATION_KEY), with Privy's gas
 * sponsorship where the app turns it on. WALLET=privy picks it.
 */
export const privyWallet: WalletProvider = {
  addresses,
  // Made when the owner chooses, owned by their authorization key; there are no keys to bring.
  create,
  sponsored,
  signer,
  asSent,
  sendStatus,
  revealKeys,
};

/**
 * A send Privy may have taken: one its API errored on (a lost connection
 * included) without turning it away. Its client already retried a timeout or
 * server error under the same idempotency key. Anything else, such as signing
 * the request before it left, is a plain error: nothing went.
 */
function submitted<T>(sent: KeptTx, send: Promise<T>): Promise<T> {
  return send.catch((error: unknown) => {
    throw error instanceof APIError && !refused(error)
      ? new MayHaveSent(sent, "Privy", error)
      : error;
  });
}

/**
 * Privy turned the request away: nothing went out. A timeout, an idempotency
 * conflict or a rate limit is no answer, since its client retries those
 * under the same idempotency key, which may already have gone through.
 */
function refused(error: unknown): boolean {
  const status = error instanceof APIError ? error.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

const hexOf = (value: bigint): `0x${string}` => `0x${value.toString(16)}`;

/** Privy says the transaction failed for good: it will never land, so nothing moved. */
class TransactionFailed extends Error {}

async function waitForPrivyTransaction(
  transactionId: string,
  chain: string,
  onSent: (hash: string) => Promise<void>,
): Promise<string> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let recorded: string | null = null;
  while (Date.now() < deadline) {
    const transaction = await privyClient().transactions().get(transactionId);
    if (transaction.transaction_hash && transaction.transaction_hash !== recorded) {
      recorded = transaction.transaction_hash;
      await onSent(recorded);
    }
    switch (transaction.status) {
      case "confirmed":
      case "finalized":
        if (!recorded) throw new Error(`Privy confirmed ${transactionId} without a hash.`);
        return recorded;
      case "execution_reverted":
        throw new TransactionFailed(
          `The transaction reverted on ${chain} (${recorded ?? transactionId}).`,
        );
      case "failed":
        throw new TransactionFailed(`The transaction failed on ${chain}.`);
      case "replaced":
      case "provider_error":
        throw new Error(`The transaction ${transaction.status.replace("_", " ")} on ${chain}.`);
      default:
        await sleep(POLL_MS);
    }
  }
  throw new Error(
    `The transaction on ${chain} was not confirmed within 3 minutes (${recorded ?? transactionId}).`,
  );
}
