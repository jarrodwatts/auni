import {
  addWatchedWalletRequestSchema,
  meSchema,
  starredSchema,
  updateMeRequestSchema,
  walletKeysResponseSchema,
  type AddWatchedWalletRequest,
  type Me,
  type UpdateMeRequest,
} from "@auni/shared";
import { requestCore } from "@/lib/core";

/** The owner: `GET /me` and `PATCH /me` on core. */

export async function getMe(): Promise<Me> {
  return meSchema.parse(await requestCore("me", { method: "GET" }));
}

/**
 * The wallet's private keys, which core shows only to a request that proves the owner is there
 * (its `auth/proof.ts`). A refusal comes back as a CoreApiError, `pair_again` among them (see
 * `mustPairAgain`). Null on a chain the wallet holds no key for.
 */
export async function revealWalletKeys(): Promise<{
  readonly evm: string | null;
  readonly solana: string | null;
}> {
  const body = await requestCore("me/keys", { method: "POST", body: "{}" });
  return walletKeysResponseSchema.parse(body).keys;
}

/**
 * Makes the owner's wallet when there's none yet (core's `POST /me/wallet`), and answers the
 * owner as they are after; one already there is left as it is.
 */
export async function makeWallet(): Promise<Me> {
  return meSchema.parse(await requestCore("me/wallet", { method: "POST", body: "{}" }));
}

/**
 * Makes the key a wallet brought with one alone lacks, beside it (`me.walletLacks`), and answers
 * the owner as they are after. A refusal, nothing to add, comes back as a CoreApiError.
 */
export async function addMissingKey(): Promise<Me> {
  return meSchema.parse(await requestCore("me/wallet/missing", { method: "POST", body: "{}" }));
}

export async function updateMe(update: UpdateMeRequest): Promise<Me> {
  const input = updateMeRequestSchema.parse(update);
  return meSchema.parse(await requestCore("me", { method: "PATCH", body: JSON.stringify(input) }));
}

/**
 * Whether the owner's GitHub account starred Auni, as core's run of their GitHub CLI says: null
 * when it couldn't say. Core records a star already given as their answer.
 */
export async function checkStar(): Promise<boolean | null> {
  return starredSchema.parse(await requestCore("me/star/check", { method: "POST", body: "{}" }))
    .starred;
}

/** Stars Auni as the owner's GitHub account, which answers the ask; false when core couldn't. */
export async function starOnGitHub(): Promise<boolean> {
  const { starred } = starredSchema.parse(
    await requestCore("me/star", { method: "POST", body: "{}" }),
  );
  return starred === true;
}

/** Records the owner's answer to the ask for a star, for every device. */
export async function answerStarPrompt(): Promise<void> {
  await requestCore("me/star/answer", { method: "POST", body: "{}" });
}

/** Adds a watch-only public EVM, ENS, or Solana address for personalization signals. */
export async function addWatchedWallet(input: AddWatchedWalletRequest): Promise<Me> {
  const body = addWatchedWalletRequestSchema.parse(input);
  return meSchema.parse(
    await requestCore("me/watched-wallets", { method: "POST", body: JSON.stringify(body) }),
  );
}

/** Removes a watch-only public address. */
export async function removeWatchedWallet(address: string): Promise<Me> {
  return meSchema.parse(
    await requestCore(`me/watched-wallets/${encodeURIComponent(address)}`, { method: "DELETE" }),
  );
}
