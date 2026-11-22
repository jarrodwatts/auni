import {
  address,
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import { hexToBytes } from "viem";
import { z } from "zod";

import { solanaKitRpc, solanaRpc } from "../../money/chains.ts";
import { formatAmount, usdLabel } from "../../money/format.ts";
import { NothingMoved, type Recipe } from "../../money/recipe.ts";
import { fetchJson } from "../../money/swaps/shared.ts";
import { solUsd } from "../../money/token-feeds.ts";

// A deposit from Solana goes through Circle's CCTP, whose message transmitter keeps the
// transfer's message in an account of its own, paid for by the depositor: 2,824,480 lamports of
// rent (about $0.20 or more of SOL), which comes back only when that payer closes the account,
// no sooner than five days after it was made, with Circle's attestation of the message. Nobody
// does that by themselves (Circle's program holds hundreds of thousands still open), so the card
// of a bridge out of Solana says the SOL comes back in five days, and that card's tap allows the
// move that gets it back then (`across_reclaim`, run by itself as ExecuteResult.later says).
//
//   bridge out of Solana --- deposit_for_burn ---> Circle's account holds the rent
//        |  later: across_reclaim at the deposit's time + RENT_HELD_MS
//        '---- reclaim_event_account (attestation from Circle's Iris) ---> rent back to the wallet

/** Circle's CCTP V2 token messenger, whose deposit_for_burn Across sends from Solana. */
export const CCTP_SOLANA = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
/** Circle's CCTP V2 message transmitter, which keeps each message's account and closes it. */
const MESSAGE_TRANSMITTER = address("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
/** sha256("global:reclaim_event_account"), as Anchor names the instruction. */
const RECLAIM_EVENT_ACCOUNT = "5ec6b49f83ec0fae";
/** Circle's domain for Solana, as its Iris API names where a message was sent from. */
const SOLANA_DOMAIN = 5;
const IRIS = "https://iris-api.circle.com";

/** The rent a deposit's message account holds, in lamports. */
const RENT_LAMPORTS = 2_824_480n;
/**
 * How long Circle holds it: five days (EVENT_ACCOUNT_WINDOW_SECONDS), and an hour more, so the
 * chain's clock, which the program reads, has passed it too.
 */
export const RENT_HELD_MS = (5 * 24 + 1) * 60 * 60_000;

/** The tool of the move that gets it back, which a bridge's card allows and no one else asks for. */
export const RECLAIM_TOOL = "across_reclaim";
/** What that move does, as Activity says it. */
export const RECLAIM_SUMMARY = "Got back the SOL Circle held for a move from Solana";

/**
 * Where a deposit from Solana, as Across built it, leaves its rent: the message account its
 * deposit_for_burn makes (its 12th account), when the wallet `payer` is the one paying for it
 * (its 2nd); else null, as there is then nothing of the owner's to get back.
 */
export function rentHeldBy(transaction: string, payer: string): string | null {
  try {
    const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    if (!("instructions" in message)) return null;
    const burn = message.instructions.find(
      ({ programAddressIndex }) => message.staticAccounts[programAddressIndex] === CCTP_SOLANA,
    );
    const at = (index: number) => {
      const position = burn?.accountIndices?.[index];
      return position === undefined ? undefined : message.staticAccounts[position];
    };
    return at(1) === payer ? (at(11) ?? null) : null;
  } catch {
    return null;
  }
}

/** A message account as Circle's program keeps it: who paid its rent, and when it was made. */
interface Held {
  readonly payer: string;
  /** Seconds since the epoch. */
  readonly createdAt: number;
}

/** The message account at `account`, or null once it's closed. */
async function readHeld(account: Address): Promise<Held | null> {
  const { value } = await solanaKitRpc()
    .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value || value.owner !== MESSAGE_TRANSMITTER) return null;
  const data = getBase64Encoder().encode(value.data[0]);
  // Anchor's 8 bytes naming the account, then rent_payer (32) and created_at (i64).
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    payer: getAddressDecoder().decode(data.subarray(8, 40)),
    createdAt: Number(view.getBigInt64(40, true)),
  };
}

/** The transaction that made the account: the oldest that names it. */
async function madeBy(account: Address): Promise<string> {
  const signatures = await solanaRpc<{ signature: string; err: unknown }[]>(
    "getSignaturesForAddress",
    [account, { limit: 1_000, commitment: "confirmed" }],
  );
  const made = signatures.findLast(({ err }) => err === null);
  if (!made) throw new Error("Solana doesn't say which transaction made Circle's account.");
  return made.signature;
}

/** The message Circle attested for a transaction from Solana, and its attestation. */
async function attested(signature: string): Promise<{ message: string; attestation: string }> {
  const { messages } = await fetchJson<{
    messages?: { message: string; attestation: string; status: string }[];
  }>(`${IRIS}/v2/messages/${SOLANA_DOMAIN}?transactionHash=${signature}`);
  const [first] = messages ?? [];
  if (!first || first.status !== "complete" || !first.attestation.startsWith("0x"))
    throw new NothingMoved(
      "Circle hasn't attested this bridge's message yet, so nothing was sent.",
    );
  return first;
}

/** Bytes as Borsh writes a Vec<u8>: its length (u32), then the bytes. */
function vec(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

/**
 * Circle's reclaim_event_account: closes `account`, paying its rent to `payee`, who paid it and
 * signs; its program checks both, and that five days have passed.
 */
async function reclaimInstruction(
  payee: Address,
  account: Address,
  { message, attestation }: { message: string; attestation: string },
): Promise<Instruction> {
  const [transmitter] = await getProgramDerivedAddress({
    programAddress: MESSAGE_TRANSMITTER,
    seeds: ["message_transmitter"],
  });
  const params = [
    vec(hexToBytes(attestation as `0x${string}`)),
    vec(hexToBytes(message as `0x${string}`)),
  ];
  const data = new Uint8Array([
    ...hexToBytes(`0x${RECLAIM_EVENT_ACCOUNT}`),
    ...params.flatMap((part) => [...part]),
  ]);
  return {
    programAddress: MESSAGE_TRANSMITTER,
    accounts: [
      { address: payee, role: AccountRole.WRITABLE_SIGNER },
      { address: transmitter, role: AccountRole.WRITABLE },
      { address: account, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/** The reclaim, as one transaction the wallet `payee` pays for, unsigned. */
async function reclaimTransaction(payee: Address, account: Address): Promise<string> {
  const instruction = await reclaimInstruction(
    payee,
    account,
    await attested(await madeBy(account)),
  );
  const { value: lifetime } = await solanaKitRpc().getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(payee, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) => appendTransactionMessageInstructions([instruction], draft),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

const SOL = Number(RENT_LAMPORTS) / 1e9;

/**
 * Gets back the SOL Circle held for a bridge out of Solana, once it allows. Never offered to the
 * agent: only a bridge's card, which says the SOL comes back, allows it, and Auni runs it by itself
 * when the time comes (ExecuteResult.later). It sends nothing but Circle's own instruction, whose
 * program pays the rent only to the wallet that paid it.
 */
export const acrossReclaim: Recipe<{ account: z.ZodString }> = {
  tool: RECLAIM_TOOL,
  description: () => null,
  input: { account: z.string().min(32).max(44) },
  venue: "across",
  // Its own card is never drawn for the owner, as the bridge's card says it; this is what that
  // card's line promised, which the drill holds execute to (rent.held.test.ts).
  async describe() {
    return {
      summary: RECLAIM_SUMMARY,
      amountUsd: "0",
      effect: { gives: [], gets: [await rentBack()], grants: [] },
    };
  },
  about: () => null,
  async execute({ input, wallets }) {
    const account = address(input.account);
    const held = await readHeld(account);
    if (!held) throw new NothingMoved("Circle's account for this bridge is closed already.");
    if (held.payer !== wallets.solanaAddress)
      throw new NothingMoved(
        "Circle holds this rent for another wallet, so there's nothing to get back.",
      );
    const due = held.createdAt * 1_000 + RENT_HELD_MS;
    if (Date.now() < due)
      throw new NothingMoved(`Circle holds it until ${new Date(due).toISOString()}.`);
    const transaction = await reclaimTransaction(address(wallets.solanaAddress), account);
    const hash = await wallets.sendSolanaTransaction(transaction);
    return {
      txs: [{ chain: "solana", hash }],
      fills: [],
      run: { filled: `Got back ${formatAmount(SOL)} SOL from Circle.` },
    };
  },
};

/**
 * What a bridge out of Solana's card says comes back: the SOL Circle holds, priced as the
 * portfolio prices SOL, or by its amount while that can't be read.
 */
export async function rentBack(): Promise<{ readonly text: string }> {
  const usd = await solUsd().then(
    (price) => SOL * price,
    () => null,
  );
  const what = usd === null ? `${formatAmount(SOL)} SOL` : `${usdLabel(usd)} of SOL`;
  return { text: `${what} back from Circle in 5 days` };
}
