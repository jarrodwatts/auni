import { ASK_LINE, EVM_CHAIN_KEYS, NETWORKS, SOLANA_BRING_FIELD } from "@auni/shared";
import { createKeyPairFromBytes, getBase58Encoder } from "@solana/kit";
import { eq, sql } from "drizzle-orm";
import { erc20Abi, type Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";

import { appById } from "../apps/registry.ts";
import { AskRefused, recordAsk } from "../asks.ts";
import { db } from "../db/client.ts";
import { messages, threads, type ThreadRow } from "../db/schema.ts";
import { deliverKind } from "../jobs/kinds.ts";
import { evmClient } from "../money/chains.ts";
import { noSolanaBring, walletAddresses } from "../money/wallets.ts";
import { privateField } from "../private-fields.ts";
import { publishThreadEvent } from "./stream.ts";
import { publishThread } from "./threads.ts";
import { answered } from "./tidy.ts";

// A private key the owner pastes into a message, from the web app or a chat app, is caught here
// before the message is stored or the agent reads it: it is never kept, and Auni answers in core's
// own words, offering the key's private field where there is one. Only what is surely a key is
// caught, so nothing else is ever held back:
//
//   Solana   base58 that decodes to 64 bytes whose second half is the public key of its first,
//            as bring.ts checks: a transaction's signature is 64 bytes too, but its halves don't
//   EVM      64 hex characters, which any transaction hash also is, so only one whose address is
//            the wallet's own, or has sent or holds money on a network Auni uses

/** A private key in what the owner typed: a Solana key, or an EVM one (the wallet's own, or not). */
export type PastedKey =
  { readonly kind: "solana" } | { readonly kind: "evm"; readonly own: boolean };

const BASE58 = "1-9A-HJ-NP-Za-km-z";
/** A run of base58 as long as a 64-byte secret's (86 to 88 characters), and no longer. */
const BASE58_RUN = new RegExp(`(?<![${BASE58}])[${BASE58}]{85,90}(?![${BASE58}])`, "gu");
/** 64 hex characters, with or without 0x, inside no longer word. */
const HEX_RUN = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/gu;
/** A message full of hashes asks the chains about its first few. */
const MOST_HEX = 4;
/** How long a chain is waited on, for each hex run, before it counts as holding nothing. */
const CHAIN_WAIT_MS = 4_000;

/** The private key in `text`, or null for a message that holds none (see above). */
export async function pastedKey(
  text: string,
  holdsMoney: (address: Address) => Promise<boolean> = everHeldMoney,
): Promise<PastedKey | null> {
  for (const [run] of text.matchAll(BASE58_RUN))
    if (await isSolanaSecret(run)) return { kind: "solana" };
  const addresses = [...text.matchAll(HEX_RUN)]
    .slice(0, MOST_HEX)
    .flatMap(([run]) => addressOf(run) ?? []);
  if (addresses.length === 0) return null;
  const own = (await walletAddresses().catch(() => null))?.evm?.toLowerCase();
  if (addresses.some((address) => address.toLowerCase() === own)) return { kind: "evm", own: true };
  const held = await Promise.all(addresses.map((address) => holdsMoney(address)));
  return held.some(Boolean) ? { kind: "evm", own: false } : null;
}

async function isSolanaSecret(run: string): Promise<boolean> {
  try {
    const bytes = getBase58Encoder().encode(run);
    // Its public half must be the key of its private half, which a signature's never is.
    return bytes.length === 64 && Boolean(await createKeyPairFromBytes(bytes));
  } catch {
    return false;
  }
}

function addressOf(run: string): Address | null {
  try {
    return privateKeyToAddress(`0x${run.replace(/^0x/u, "")}`);
  } catch {
    return null;
  }
}

/** Whether an address has sent anything, or holds its network's coin or USDC, anywhere Auni looks. */
async function everHeldMoney(address: Address): Promise<boolean> {
  const looks = EVM_CHAIN_KEYS.flatMap((key) => {
    const { viem, usdc } = NETWORKS[key];
    const client = evmClient(viem.id);
    return [
      client.getTransactionCount({ address }).then((sent) => sent > 0),
      client.getBalance({ address }).then((wei) => wei > 0n),
      ...(usdc
        ? [
            client
              .readContract({
                address: usdc as Address,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [address],
              })
              .then((units) => units > 0n),
          ]
        : []),
    ];
  });
  const seen = await Promise.all(looks.map((look) => within(look).catch(() => false)));
  return seen.some(Boolean);
}

function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, failed) =>
      setTimeout(() => failed(new Error("no answer")), CHAIN_WAIT_MS).unref(),
    ),
  ]);
}

/** The owner's message that held a key, by its id and the chat app it came from, if any. */
interface Withheld {
  readonly id: string;
  readonly channel?: string;
}

/**
 * Answers a message that held a private key in its place: nothing of the message is kept, and
 * Auni's answer, stored under the message's own id so a retried send answers once, says so in
 * core's words. A Solana key the wallet could take comes with its private field's card; one that
 * came through a chat app has passed through that service already, which the answer says.
 */
export async function keepKeyOut(thread: ThreadRow, message: Withheld, key: PastedKey) {
  const [already] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, message.id));
  if (already) return;
  const refused = key.kind === "solana" ? await noSolanaBring() : null;
  const card =
    key.kind === "solana" && refused === null
      ? await solanaCard(thread).catch((error: unknown) => {
          console.error("the card for a pasted Solana key couldn't be made", error);
          return null;
        })
      : null;
  const via = message.channel ? (appById(message.channel)?.about.name ?? "that chat app") : null;
  const what =
    key.kind === "solana"
      ? "a Solana private key"
      : key.own
        ? "the wallet's private key"
        : "the private key to an account with money in it";
  const text = [
    `That's ${key.kind === "evm" && key.own ? "your wallet's private key" : what}, so I didn't keep your message or read it.`,
    card
      ? "To add it to your wallet, paste it into this card instead."
      : key.kind === "solana"
        ? (refused ?? "To add it to your wallet, open Settings, under Wallet.")
        : key.own
          ? null
          : "I can't take an EVM key in beside the one your wallet holds.",
    via
      ? `It has already passed through ${via}, so delete it there, and treat it as seen: move what it holds to a key only you have${card ? ", such as a new Solana address from Settings" : ""}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  await db.transaction(async (tx) => {
    const [posted] = await tx
      .insert(messages)
      .values({
        id: message.id,
        threadId: thread.id,
        role: "assistant",
        parts: [
          { type: "text", text },
          ...(card ? [{ type: "data-cards", id: message.id, data: { cards: [card] } }] : []),
        ],
        origin: "automation",
        // What the agent reads of it in the thread's history (see renderMessage): never the key.
        metadata: {
          reason: `The owner pasted ${what} into the chat, so Auni kept that message from you.`,
          posted: true,
        },
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (!posted) return;
    await tx
      .update(threads)
      .set({ ...answered(), updatedAt: sql`now()` })
      .where(eq(threads.id, thread.id));
    if (message.channel)
      await deliverKind.enqueue(tx, {
        channel: message.channel,
        threadId: thread.id,
        messageId: message.id,
      });
  });
  await publishThread(thread.id);
  publishThreadEvent(thread.id, { kind: "posted", messageId: message.id });
}

const SOLANA_WHY =
  "Added beside your EVM key, its Solana money shows here and Auni can trade with it.";

/** The card that brings a Solana key into the wallet, or null where one is waiting already. */
async function solanaCard(thread: ThreadRow) {
  const field = await privateField(SOLANA_BRING_FIELD);
  if (!field) return null;
  try {
    const { card } = await recordAsk(
      { threadId: thread.id },
      "request_secret",
      { field: field.id, app: field.app, why: SOLANA_WHY },
      { summary: field.label, lines: [{ label: ASK_LINE.why, value: SOLANA_WHY }] },
    );
    return card;
  } catch (error) {
    if (error instanceof AskRefused) return null;
    throw error;
  }
}
