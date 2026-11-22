import {
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { bytesToHex } from "viem";
import { expect, vi } from "vitest";

import { holdsToCard } from "../../test/held-to-card.ts";
import { OWNER } from "../../test/wallets.ts";

// Getting back the SOL Circle held for a bridge out of Solana, five days on. Circle's program
// keeps the deposit's message in an account whose rent the wallet paid, and pays it back only to
// that wallet; Solana answers with that account (`world.payer` paid it, `world.age` ago), and
// Circle's Iris with the message it attested. Auni builds the one instruction itself.
const MESSAGE_ACCOUNT = "4WggwDc8tGnBsSRTUBLVDjhF1Pytrn258xWL2ZbknfC6";
const TRANSMITTER = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const STRANGER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const DAY = 24 * 60 * 60;
const world = vi.hoisted(() => ({ payer: "", age: 0, closed: false }));

/** The account as Circle's program keeps it: 8 bytes naming it, rent_payer, created_at, message. */
function account(): string {
  const data = new Uint8Array(8 + 32 + 8 + 4 + 3);
  data.set(getAddressEncoder().encode(world.payer as never), 8);
  new DataView(data.buffer).setBigInt64(
    40,
    BigInt(Math.floor(Date.now() / 1000) - world.age),
    true,
  );
  new DataView(data.buffer).setUint32(48, 3, true);
  return Buffer.from(data).toString("base64");
}

vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  solanaKitRpc: () =>
    ({
      getAccountInfo: () => ({
        send: async () => ({
          value: world.closed ? null : { owner: TRANSMITTER, data: [account(), "base64"] },
        }),
      }),
      getLatestBlockhash: () => ({
        send: async () => ({
          value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n },
        }),
      }),
    }) as never,
  solanaRpc: (async (method: string) => {
    if (method !== "getSignaturesForAddress") throw new Error(`unexpected ${method}`);
    return [{ signature: "made-it", err: null }];
  }) as never,
}));
vi.mock(import("../../money/swaps/shared.ts"), async (original) => ({
  ...(await original()),
  fetchJson: (async (url: string) => {
    expect(String(url)).toBe("https://iris-api.circle.com/v2/messages/5?transactionHash=made-it");
    return { messages: [{ message: "0x0102", attestation: "0xaabbcc", status: "complete" }] };
  }) as never,
}));
vi.mock(import("../../money/token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => 100,
}));

holdsToCard("across_reclaim", {
  world() {
    world.payer = OWNER.solana;
    world.age = 6 * DAY;
    world.closed = false;
  },
  asShown: { "the SOL Circle held for a bridge out of Solana": { account: MESSAGE_ACCOUNT } },
  paysAsShown(signed, card) {
    expect(card.lines).toEqual([
      { label: "You get", value: "$0.28 of SOL back from Circle in 5 days" },
    ]);
    expect(signed.evm).toEqual([]);
    expect(signed.solana).toHaveLength(1);
    const { messageBytes } = getTransactionDecoder().decode(
      getBase64Encoder().encode(signed.solana[0]!.base64Tx),
    );
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    if (!("instructions" in message)) throw new Error("not a transaction Auni builds");
    const accounts = message.staticAccounts;
    // The wallet pays its fee, and Circle's program alone is called: reclaim_event_account,
    // paying the rent to the wallet, which signs, from the message's account.
    expect(accounts[0]).toBe(OWNER.solana);
    expect(message.instructions).toHaveLength(1);
    const [reclaim] = message.instructions;
    expect(accounts[reclaim!.programAddressIndex]).toBe(TRANSMITTER);
    const named = reclaim!.accountIndices!.map((index) => accounts[index]);
    expect(named[0]).toBe(OWNER.solana);
    expect(named[2]).toBe(MESSAGE_ACCOUNT);
    // Its 8 bytes, then the attestation and the message, each as Borsh writes bytes.
    expect(bytesToHex(new Uint8Array(reclaim!.data!))).toBe(
      "0x5ec6b49f83ec0fae03000000aabbcc020000000102",
    );
  },
  priceMoved: {
    never: "nothing is priced: it gets back the rent Circle holds, whatever SOL is worth",
  },
  takesMore: { never: "it spends only its network fee, and Circle's program pays the rent back" },
  paysElsewhere: {
    "Circle's account holds rent another wallet paid": {
      input: { account: MESSAGE_ACCOUNT },
      after: () => {
        world.payer = STRANGER;
      },
    },
  },
});
