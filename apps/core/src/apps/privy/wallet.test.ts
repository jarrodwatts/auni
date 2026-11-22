import { generateKeyPairSync } from "node:crypto";

import { APIConnectionError, APIError, PrivyAPIError } from "@privy-io/node";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Privy is stood in, its app sponsoring gas nowhere.
const sendCalls = vi.fn(async (_wallet: string, body: { sponsor: boolean }) => {
  if (body.sponsor) throw new Error("Gas sponsorship is not configured for this chain.");
  return { transaction_id: "t" };
});
const sendTransaction = vi.fn(async () => ({ transaction_id: "t", hash: "0x" }));
const signAndSendTransaction = vi.fn(async () => ({ hash: "signature" }));
const SOLANA_WALLET = address("JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n");
const EVM_WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// The owner's authorization key, as the Privy dashboard gives it; env reads it as each test
// loads the wallet afresh.
const owner = generateKeyPairSync("ec", { namedCurve: "P-256" });
const AUTHORIZATION_KEY = `wallet-auth:${owner.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`;
process.env.PRIVY_AUTHORIZATION_KEY = AUTHORIZATION_KEY;

// The app holds Auni's two wallets already, unless a test empties it.
const APP_WALLETS = [
  { id: "w", chain_type: "ethereum", external_id: "auni-evm", address: EVM_WALLET },
  { id: "s", chain_type: "solana", external_id: "auni-solana", address: SOLANA_WALLET },
];
const made = [...APP_WALLETS];
const list = vi.fn(async ({ external_id }: { external_id: string }) => ({
  data: made.filter((wallet) => wallet.external_id === external_id),
}));
const create = vi.fn(
  async (body: { chain_type: string; external_id: string; owner: { public_key: string } }) => {
    const wallet = { id: `new-${body.chain_type}`, ...body, address: `${body.chain_type}-address` };
    made.push(wallet);
    return wallet;
  },
);
const exportPrivateKey = vi.fn(async (id: string) => ({ private_key: `key-of-${id}` }));
// Privy's sends by its id for each, as its API tells them; any other has landed.
const privySends: Record<string, { status: string; transaction_hash?: string }> = {
  landed: { status: "confirmed", transaction_hash: "0xabc" },
  broadcast: { status: "broadcasted" },
  queued: { status: "pending" },
  dropped: { status: "failed" },
};
vi.mock("./client.ts", () => ({
  privyClient: () => ({
    wallets: () => ({
      list,
      create,
      exportPrivateKey,
      ethereum: () => ({ sendCalls, sendTransaction }),
      solana: () => ({ signAndSendTransaction }),
    }),
    transactions: () => ({ get: async (id: string) => privySends[id] ?? privySends.landed }),
  }),
}));
// No chain answers but to say what code the wallet's address runs, which a test may set.
const code = vi.hoisted(() => ({ now: undefined as string | undefined }));
vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original()),
  evmClient: () => ({ getCode: async () => code.now }),
  waitForSolanaSignature: async () => {},
}));
// Whether the wallet can pay its own gas, which no chain here can say unless a test does.
const assertOwnGas = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));
vi.mock("../../money/gas.ts", async (original) => ({ ...(await original()), assertOwnGas }));

const ROUTER = "0x2222222222222222222222222222222222222222";
const batch = [
  { to: ROUTER, data: "0x01" },
  { to: ROUTER, data: "0x02" },
];
const onSent = vi.fn(async () => {});

// The wallets are read once per process, so each test starts from a fresh one.
let privyWallet: typeof import("./wallet.ts").privyWallet;
let MayHaveSent: typeof import("../../money/recipe.ts").MayHaveSent;
beforeEach(async () => {
  made.splice(0, made.length, ...APP_WALLETS);
  vi.clearAllMocks();
  vi.resetModules();
  ({ privyWallet } = await import("./wallet.ts"));
  ({ MayHaveSent } = await import("../../money/recipe.ts"));
});
const wallets = (attempt = 1) => privyWallet.signer({ actionId: "a", attempt, onSent });

describe("addresses", () => {
  it("finds the app's wallets by their external ids", async () => {
    await expect(privyWallet.addresses()).resolves.toEqual({
      evm: EVM_WALLET,
      solana: SOLANA_WALLET,
    });
    expect(list.mock.calls.map(([query]) => query.external_id).toSorted()).toEqual([
      "auni-evm",
      "auni-solana",
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it("makes none on asking: no addresses, keys or signer until the owner makes them", async () => {
    made.length = 0;
    await expect(privyWallet.addresses()).resolves.toEqual({ evm: null, solana: null });
    await expect(privyWallet.revealKeys()).rejects.toThrow(/no wallet yet/u);
    await expect(wallets()).rejects.toThrow(/no wallet yet/u);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("create", () => {
  it("makes each wallet, owned by the authorization key, once", async () => {
    made.length = 0;
    expect(await privyWallet.create()).toEqual({
      evm: "ethereum-address",
      solana: "solana-address",
    });
    expect(await privyWallet.addresses()).toEqual({
      evm: "ethereum-address",
      solana: "solana-address",
    });
    expect(create).toHaveBeenCalledTimes(2);
    const publicKey = owner.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    for (const [body] of create.mock.calls)
      expect(body).toMatchObject({
        external_id: body.chain_type === "ethereum" ? "auni-evm" : "auni-solana",
        owner: { public_key: publicKey },
        idempotency_key: body.external_id,
      });
    await expect(privyWallet.create()).rejects.toThrow(/wallet already/u);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("finishes a pair an earlier try left half made", async () => {
    made.splice(1);
    await expect(privyWallet.addresses()).resolves.toEqual({ evm: null, solana: null });
    expect(await privyWallet.create()).toEqual({ evm: EVM_WALLET, solana: "solana-address" });
    expect(create.mock.calls.map(([body]) => body.chain_type)).toEqual(["solana"]);
  });

  it("refuses when the app holds both already", async () => {
    await expect(privyWallet.create()).rejects.toThrow(/wallet already/u);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("sponsored", () => {
  it("is Privy's sponsorship everywhere but Ethereum, Solana's fees and rent included", () => {
    expect(privyWallet.sponsored?.(1)).toBe(false);
    for (const chain of [143, 8453, 10, "solana"] as const)
      expect(privyWallet.sponsored?.(chain)).toBe(true);
  });
});

describe("asSent", () => {
  const owner = "0x1111111111111111111111111111111111111111";
  const KERNEL = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28";

  it("says one call goes as built", async () => {
    expect(await privyWallet.asSent!(1, owner, [{ ...batch[0]!, value: "7" }])).toEqual({
      to: ROUTER,
      data: "0x01",
      value: 7n,
    });
  });

  it("costs a list as a batch run by the account code Privy puts the address under", async () => {
    code.now = undefined;
    const fresh = await privyWallet.asSent!(1, owner, batch);
    expect(fresh).toMatchObject({ to: owner, value: 0n, delegates: KERNEL });
    // ERC-7579's execute, which the account calls on itself.
    expect(fresh!.data).toMatch(/^0xe9ae5c53/u);
    // An address that runs account code already is costed under that code, as it is.
    code.now = `0xef0100${KERNEL.slice(2).toLowerCase()}`;
    const delegated = await privyWallet.asSent!(1, owner, batch);
    expect(delegated).toEqual({ to: owner, data: fresh!.data, value: 0n });
  });
});

describe("sendEvmTransaction", () => {
  it("sends a list on Ethereum as one transaction the wallet pays for, once its gas is covered", async () => {
    await expect((await wallets()).sendEvmTransaction(1, batch)).resolves.toBe("0xabc");
    expect(assertOwnGas).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveBeenLastCalledWith("w", expect.objectContaining({ sponsor: false }));
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("sends one call on Ethereum as a plain transaction, which can carry a tip", async () => {
    await expect((await wallets()).sendEvmTransaction(1, batch[0]!)).resolves.toBe("0xabc");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it("sends nothing the wallet can't pay the gas of", async () => {
    assertOwnGas.mockRejectedValueOnce(new Error("Nothing was sent: too little ETH."));
    await expect((await wallets()).sendEvmTransaction(1, batch)).rejects.toThrow(
      "Nothing was sent: too little ETH.",
    );
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it("sends a batch whole, paying its own gas, where gas isn't sponsored", async () => {
    for (const chainId of [8453, 10]) {
      await expect((await wallets()).sendEvmTransaction(chainId, batch)).resolves.toBe("0xabc");
      expect(sendCalls).toHaveBeenLastCalledWith("w", expect.objectContaining({ sponsor: false }));
    }
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("sends one call as a plain transaction where gas isn't sponsored", async () => {
    await expect((await wallets()).sendEvmTransaction(10, batch[0]!)).resolves.toBe("0xabc");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps a send by Privy's id for it until its hash comes back, then by both", async () => {
    await (await wallets()).sendEvmTransaction(8453, batch);
    expect(onSent.mock.calls).toEqual([
      [{ chain: "base", walletTxId: "t" }],
      [{ chain: "base", walletTxId: "t", hash: "0xabc" }],
    ]);
  });

  it("keeps by its hash a send Privy made but gave no id for", async () => {
    sendTransaction.mockResolvedValueOnce({ hash: "0xsent" } as never);
    const sent = (await wallets()).sendEvmTransaction(1, batch[0]!);
    await expect(sent).rejects.toBeInstanceOf(MayHaveSent);
    await expect(sent).rejects.toMatchObject({ sent: { hash: "0xsent" } });
  });
});

describe("sendSolanaTransaction", () => {
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(SOLANA_WALLET, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n },
          draft,
        ),
      (draft) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            accounts: [{ address: SOLANA_WALLET, role: AccountRole.WRITABLE_SIGNER }],
          },
          draft,
        ),
    ),
  );
  const tx = getBase64EncodedWireTransaction(compiled);
  const sponsored = () =>
    (signAndSendTransaction.mock.lastCall as unknown as [string, { sponsor: boolean }])[1].sponsor;

  // Privy answers a key it saw in the last day with that send, so a run tried
  // again must never reuse one an earlier run of the move sent under.
  it("sends each run of a move under its own keys", async () => {
    const keys = async (attempt: number) => {
      signAndSendTransaction.mockClear();
      const sending = await wallets(attempt);
      await sending.sendSolanaTransaction(tx, { setup: true });
      await sending.sendSolanaTransaction(tx);
      return (
        signAndSendTransaction.mock.calls as unknown as [string, { idempotency_key: string }][]
      ).map(([, body]) => body.idempotency_key);
    };
    const first = await keys(1);
    const again = await keys(2);
    expect(new Set([...first, ...again]).size).toBe(4);
  });

  it("has Privy sponsor it", async () => {
    await (await wallets()).sendSolanaTransaction(tx);
    expect(sponsored()).toBe(true);
  });

  it("sends one that pays its own way as built, with the wallet as its fee payer", async () => {
    await (await wallets()).sendSolanaTransaction(tx, { paysOwnFee: true });
    expect(sponsored()).toBe(false);
  });

  it("keeps a setup step as one", async () => {
    await (await wallets()).sendSolanaTransaction(tx, { setup: true });
    expect(onSent).toHaveBeenLastCalledWith({ chain: "solana", hash: "signature", setup: true });
  });

  // Its action then stays running rather than failing, which would have the person send it again.
  it("says a send Privy never answered may have gone", async () => {
    signAndSendTransaction.mockRejectedValueOnce(
      new APIConnectionError({ message: "socket hang up" }),
    );
    const unanswered = (await wallets()).sendSolanaTransaction(tx, { setup: true });
    await expect(unanswered).rejects.toBeInstanceOf(MayHaveSent);
    await expect(unanswered).rejects.toMatchObject({ sent: { chain: "solana", setup: true } });
  });

  it("says nothing went when Privy turned the send away", async () => {
    const turnedAway = APIError.generate(400, undefined, "bad transaction", new Headers());
    signAndSendTransaction.mockRejectedValueOnce(turnedAway);
    await expect((await wallets()).sendSolanaTransaction(tx)).rejects.toBe(turnedAway);
  });

  // Privy signs the request before it leaves, so a failure there sent nothing.
  it("says nothing went when the request failed before it left", async () => {
    const unsigned = new PrivyAPIError("Failed to serialize request for authorization signature");
    signAndSendTransaction.mockRejectedValueOnce(unsigned);
    await expect((await wallets()).sendSolanaTransaction(tx)).rejects.toBe(unsigned);
  });
});

describe("sendStatus", () => {
  it("reads a send Privy took by its id, and gives its hash once it has one", async () => {
    await expect(privyWallet.sendStatus("landed")).resolves.toEqual({ hash: "0xabc" });
  });

  // Read as failed, a send still on its way would have the owner send it again, and both land.
  it("says a send with no hash yet is still on its way, and failed only once Privy says so", async () => {
    await expect(privyWallet.sendStatus("broadcast")).resolves.toBe("pending");
    await expect(privyWallet.sendStatus("queued")).resolves.toBe("pending");
    await expect(privyWallet.sendStatus("dropped")).resolves.toBe("failed");
  });
});

describe("revealKeys", () => {
  it("exports both wallets' keys with the authorization key", async () => {
    await expect(privyWallet.revealKeys()).resolves.toEqual({
      evm: expect.stringMatching(/^key-of-/u),
      solana: expect.stringMatching(/^key-of-/u),
    });
    for (const [, body] of exportPrivateKey.mock.calls as unknown as [string, object][])
      expect(body).toEqual({
        authorization_context: { authorization_private_keys: [AUTHORIZATION_KEY] },
      });
  });
});
