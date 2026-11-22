import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";

import type { Approved } from "./approved.ts";
import { SOLANA_USDC, solanaKitRpc } from "./chains.ts";
import type { SentTx, Signer } from "./recipe.ts";
import { solFor, topUpSol, type SolTopUp } from "./sol-top-up.ts";
import { noAddressOn, paysOwnGas } from "./wallets.ts";

// On Solana each owner's USDC sits in an account of its own, which takes nothing in until
// someone opens it and pays its rent. A swap or a transfer opens the one it pays as it goes, but
// Circle's CCTP mints only into one already open, so a bridge quotes no move landing USDC with an
// owner who has none: every fresh Auni wallet, and any new wallet a withdrawal goes to. A wallet
// that pays its own way pays that rent in SOL, so it buys what it lacks first (see sol-top-up.ts).

/** `owner`'s USDC account: its associated token account for USDC. */
export async function usdcAccountOf(owner: string): Promise<Address> {
  const [account] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: SOLANA_USDC.mint,
    tokenProgram: SOLANA_USDC.tokenProgram,
  });
  return account;
}

async function isOpen(account: Address): Promise<boolean> {
  const { value } = await solanaKitRpc()
    .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
    .send();
  return value?.owner === SOLANA_USDC.tokenProgram;
}

/**
 * The instruction that opens `owner`'s USDC account (`account`) unless it's open, its rent paid
 * by `payer`. Named as payer, a wallet with a sponsor pays nothing: the sponsor's fee payer takes its
 * place and pays the rent too, as swaps opening accounts this way show on chain; one with
 * none pays it in SOL. Once the account is open it does nothing, so a retry or a move racing it
 * is harmless.
 */
export function opensUsdcAccount(payer: Address, owner: string, account: Address): Instruction {
  return getCreateAssociatedTokenIdempotentInstruction({
    payer: createNoopSigner(payer),
    ata: account,
    owner: address(owner),
    mint: SOLANA_USDC.mint,
    tokenProgram: SOLANA_USDC.tokenProgram,
  });
}

/** The transaction that opens `owner`'s USDC account, `payer` paying, or null when it's open. */
async function opening(payer: string, owner: string): Promise<string | null> {
  const account = await usdcAccountOf(owner);
  if (await isOpen(account)) return null;
  const { value: lifetime } = await solanaKitRpc().getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(payer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) =>
      appendTransactionMessageInstructions(
        [opensUsdcAccount(address(payer), owner, account)],
        draft,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/**
 * How `payer`, a wallet that pays its own way, buys the SOL opening `owner`'s USDC account needs
 * (see sol-top-up.ts), for its card; null when it's open, the wallet holds enough, or its sponsor
 * pays.
 */
export async function solToOpen(payer: string, owner: string): Promise<SolTopUp | null> {
  if (!(await paysOwnGas("solana"))) return null;
  const transaction = await opening(payer, owner);
  return transaction ? solFor(transaction, payer) : null;
}

/**
 * Opens `owner`'s USDC account when it isn't yet, from the wallet's Solana address in a transaction
 * its sponsor pays for, rent and all, or that it pays for in SOL (see opensUsdcAccount), buying
 * first what it lacks of that, as its card (`approved`) showed. Returns what it sent as setup,
 * once confirmed (sendSolanaTransaction waits for that), or none when the account was open.
 */
export async function openUsdcAccount(
  wallets: Signer,
  owner: string,
  approved?: Approved,
): Promise<SentTx[]> {
  if (!wallets.solanaAddress) throw new Error(noAddressOn("Solana"));
  const payer = wallets.solanaAddress;
  const first = await opening(payer, owner);
  if (!first) return [];
  const topUp = await solFor(first, payer, { approved });
  const txs = topUp ? await topUpSol(wallets, topUp) : [];
  // Built again once SOL is bought, on a blockhash that wait can't have outlived.
  const transaction = topUp ? await opening(payer, owner) : first;
  if (!transaction) return txs;
  const hash = await wallets.sendSolanaTransaction(transaction, { setup: true });
  return [...txs, { chain: "solana", hash, setup: true }];
}
