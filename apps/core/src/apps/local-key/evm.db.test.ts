import { eq } from "drizzle-orm";
import {
  createPublicClient,
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  keccak256,
  parseTransaction,
  TimeoutError,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../db/client.ts";
import { actions } from "../../db/schema.ts";
import { signedTxs } from "./tables.ts";
import { evmClient } from "../../money/chains.ts";
import { MayHaveSent, type KeptTx } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import { insertAction, wipe } from "../../test/db.ts";
import { asSent, DELEGATOR, evmSendStatus, resendEvm, sendEvmTransaction } from "./evm.ts";

vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original()),
  evmClient: vi.fn(),
}));
// Gas is the wallet's own to check; these tests are about what's signed and sent, and one says
// what the check refuses (how it judges a send is gas.test.ts).
const fees = vi.hoisted(() => ({ today: { tip: 1n, baseFee: 10n, maxFee: 21n } }));
const assertOwnGas = vi.hoisted(() => vi.fn(async (..._send: unknown[]): Promise<void> => {}));
vi.mock("../../money/gas.ts", async (original) => ({
  ...(await original()),
  assertOwnGas,
  ownGasFees: async () => fees.today,
}));

const account = privateKeyToAccount(
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
);
const ROUTER = "0x2222222222222222222222222222222222222222";
const BASE = 8453;

/**
 * A chain as its JSON-RPC answers it: what it has seen, what it mined, and whatever a test
 * says it does with the next send.
 */
function fakeChain() {
  const chain = {
    /** Every raw transaction sent to it, rebroadcasts included. */
    sent: [] as Hex[],
    seen: new Map<Hex, Hex>(),
    mined: new Set<Hex>(),
    /** The account's count of transactions mined. */
    latest: 0,
    /** Blocks mined since it began. */
    blocks: 0,
    code: new Map<string, Hex>([[DELEGATOR.toLowerCase(), "0x6080"]]),
    /** What the next send gets: taken, no answer, an error answer, or one for a send it took. */
    next: [] as ("taken" | "no answer" | "refused" | "known")[],
    /** The account's coin. */
    balance: 10n ** 18n,
    /** What it was asked to estimate the gas of: the call, and any state it was told to assume. */
    estimated: [] as unknown[][],
  };
  const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    const [first] = (params ?? []) as [string];
    switch (method) {
      case "eth_chainId":
        return `0x${BASE.toString(16)}`;
      case "eth_getTransactionCount": {
        const pending =
          chain.latest + [...chain.seen.keys()].filter((h) => !chain.mined.has(h)).length;
        return `0x${(params?.[1] === "pending" ? pending : chain.latest).toString(16)}`;
      }
      case "eth_getBalance":
        return `0x${chain.balance.toString(16)}`;
      case "eth_getCode":
        return chain.code.get(first.toLowerCase()) ?? "0x";
      case "eth_estimateGas":
        chain.estimated.push(params ?? []);
        return "0x5208";
      case "eth_sendRawTransaction": {
        chain.sent.push(first as Hex);
        const hash = keccak256(first as Hex);
        const next = chain.next.shift() ?? "taken";
        if (next === "no answer") throw new TimeoutError({ body: {}, url: "rpc" });
        if (next === "refused") throw { code: -32000, message: "nonce too low" };
        const known = chain.seen.has(hash);
        // A send at a nonce another one waiting holds takes its place, as a node's pool does.
        for (const [other, raw] of chain.seen)
          if (other !== hash && !chain.mined.has(other) && nonceOf(raw) === nonceOf(first as Hex))
            chain.seen.delete(other);
        chain.seen.set(hash, first as Hex);
        if (known || next === "known") throw { code: -32000, message: "already known" };
        return hash;
      }
      case "eth_getTransactionByHash":
        return chain.seen.has(first as Hex) ? transaction(first as Hex) : null;
      case "eth_getTransactionReceipt":
        return chain.mined.has(first as Hex) ? receipt(first as Hex) : null;
      case "eth_blockNumber":
        return `0x${(16 + chain.blocks).toString(16)}`;
      case "eth_getBlockByNumber":
        return block;
      default:
        throw new Error(`The fake chain doesn't answer ${method}.`);
    }
  };
  vi.mocked(evmClient).mockReturnValue(
    createPublicClient({
      transport: custom({ request }, { retryCount: 0 }),
      pollingInterval: 20,
    }) as never,
  );
  /** Mines whatever it has seen, as the next block would. */
  const mine = () => {
    chain.blocks += 1;
    for (const hash of chain.seen.keys()) {
      if (chain.mined.has(hash)) continue;
      chain.mined.add(hash);
      chain.latest += 1;
    }
  };
  return { chain, mine };
}

const block = {
  number: "0x10",
  hash: `0x${"11".repeat(32)}`,
  parentHash: `0x${"10".repeat(32)}`,
  timestamp: "0x1",
  baseFeePerGas: "0xa",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  transactions: [],
};

const transaction = (hash: Hex) => ({
  hash,
  from: account.address,
  to: ROUTER,
  nonce: "0x0",
  value: "0x0",
  input: "0x",
  gas: "0x5208",
  type: "0x2",
  chainId: "0x2105",
});

const receipt = (hash: Hex) => ({
  transactionHash: hash,
  status: "0x1",
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: "0x10",
  transactionIndex: "0x0",
  from: account.address,
  to: ROUTER,
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x1",
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  type: "0x2",
  contractAddress: null,
});

beforeEach(async () => {
  fees.today = { tip: 1n, baseFee: 10n, maxFee: 21n };
  await wipe(actions, signedTxs);
});

let actionId = "";
const kept: KeptTx[] = [];
beforeEach(async () => {
  actionId = (await insertAction()).id;
  kept.length = 0;
});
const options = () => ({
  actionId,
  attempt: 1,
  onSent: async (tx: KeptTx) => void kept.push(tx),
});
const journalled = () => db.select().from(signedTxs).orderBy(signedTxs.createdAt);
/**
 * A send journalled at `nonce` that no node has, as a crash or an unanswered send leaves it;
 * `minutes` ago, at the fees the test's chain asked for then.
 */
async function journalAt(nonce: number, minutes = 0): Promise<Hex> {
  const raw = await account.signTransaction({
    chainId: BASE,
    nonce,
    to: ROUTER,
    data: "0x0c",
    value: 7n,
    gas: 21_000n,
    maxFeePerGas: 21n,
    maxPriorityFeePerGas: 1n,
  });
  await db.insert(signedTxs).values({
    actionId,
    chain: "base",
    address: account.address,
    nonce,
    raw,
    hash: keccak256(raw),
    createdAt: new Date(Date.now() - minutes * 60_000),
  });
  return raw;
}
const nonceOf = (raw: Hex) => parseTransaction(raw).nonce;

describe("sendEvmTransaction", () => {
  it("journals the signed bytes, keeps the send by its hash and journal id, then sends it", async () => {
    const { chain, mine } = fakeChain();
    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x01" }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(1));
    mine();
    const hash = await sending;

    const [row] = await journalled();
    expect(row).toMatchObject({ chain: "base", nonce: 0, hash, raw: chain.sent[0] });
    expect(kept).toEqual([{ chain: "base", hash, walletTxId: row!.id }]);
    expect(parseTransaction(chain.sent[0]!)).toMatchObject({ type: "eip1559", to: ROUTER });
  });

  it("sends a list as one call to the account itself, through the DeleGator it delegates to", async () => {
    const { chain, mine } = fakeChain();
    chain.latest = 3;
    const calls = [
      { to: ROUTER, data: "0x01", setup: true as const },
      { to: ROUTER, data: "0x02", value: "5" },
    ];
    const sending = sendEvmTransaction(account, BASE, calls, options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(1));
    mine();
    await sending;

    const sent = parseTransaction(chain.sent[0]!);
    expect(sent).toMatchObject({
      type: "eip7702",
      to: account.address.toLowerCase(),
      nonce: 3,
    });
    expect(sent.value ?? 0n).toBe(0n);
    // The send takes nonce 3, so the authorization it carries takes 4.
    expect(sent.authorizationList).toMatchObject([
      { address: DELEGATOR.toLowerCase(), chainId: BASE, nonce: 4 },
    ]);
    const { args } = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "execute",
          inputs: [
            { name: "mode", type: "bytes32" },
            { name: "executionCalldata", type: "bytes" },
          ],
          outputs: [],
          stateMutability: "payable",
        },
      ],
      data: sent.data!,
    });
    expect(args[0]).toBe(`0x01${"00".repeat(31)}`);
    const [executions] = decodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "callData", type: "bytes" },
          ],
        },
      ],
      args[1],
    );
    expect(executions).toEqual([
      { target: ROUTER, value: 0n, callData: "0x01" },
      { target: ROUTER, value: 5n, callData: "0x02" },
    ]);
    // A list is kept as setup only when every call in it is.
    expect(kept[0]).not.toHaveProperty("setup");
    // Its gas limit is asked for with nothing signed: the node estimates the call as if the
    // account ran the DeleGator already, and the authorization's 25,000 gas joins its 21,000
    // before the quarter over, as ownGas costs the same send (asSent) for the card.
    const delegated = { code: `0xef0100${DELEGATOR.slice(2).toLowerCase()}` };
    expect(chain.estimated).toEqual([
      [
        { from: account.address, to: account.address, data: sent.data, value: "0x0" },
        "latest",
        { [account.address]: delegated },
      ],
    ]);
    expect(sent.gas).toBe(57_500n);
    expect(await asSent(BASE, account.address, calls)).toEqual({
      to: account.address,
      data: sent.data,
      value: 0n,
      delegates: DELEGATOR,
    });
  });

  it("says one call goes as built, and a list where it can't go as one doesn't go", async () => {
    const { chain } = fakeChain();
    expect(await asSent(BASE, account.address, [{ to: ROUTER, data: "0x01", value: "7" }])).toEqual(
      { to: ROUTER, data: "0x01", value: 7n },
    );
    chain.code.clear();
    // Polygon, so no earlier test has found the DeleGator there.
    expect(await asSent(137, account.address, [{ to: ROUTER }, { to: ROUTER }])).toBeNull();
  });

  it("carries no authorization once the account is the DeleGator's", async () => {
    const { chain, mine } = fakeChain();
    chain.code.set(account.address.toLowerCase(), `0xef0100${DELEGATOR.slice(2).toLowerCase()}`);
    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER }, { to: ROUTER }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(1));
    mine();
    await sending;
    expect(parseTransaction(chain.sent[0]!)).toMatchObject({
      type: "eip1559",
      to: account.address.toLowerCase(),
      // A quarter over the node's estimate of the call as it is, with no state assumed.
      gas: 26_250n,
    });
    expect(chain.estimated.map((asked) => asked.length)).toEqual([1]);
    expect(
      await asSent(BASE, account.address, [{ to: ROUTER }, { to: ROUTER }]),
    ).not.toHaveProperty("delegates");
  });

  it("refuses a list where the DeleGator isn't deployed, before signing anything", async () => {
    const { chain } = fakeChain();
    chain.code.clear();
    // OP Mainnet, so no earlier test has found the DeleGator there.
    await expect(
      sendEvmTransaction(account, 10, [{ to: ROUTER }, { to: ROUTER }], options()),
    ).rejects.toThrow(
      "Auni can't send these calls all-or-nothing on OP Mainnet, so nothing was sent.",
    );
    expect(chain.sent).toEqual([]);
    expect(await journalled()).toEqual([]);
  });

  it("asks whether the wallet can pay for the send, and signs nothing when it can't", async () => {
    const { chain } = fakeChain();
    const calls = [{ to: ROUTER, data: "0x01" }];
    assertOwnGas.mockRejectedValueOnce(
      new Refused("funds", "Nothing was sent: too little ETH for the network fee."),
    );
    await expect(sendEvmTransaction(account, BASE, calls, options())).rejects.toThrow(
      "Nothing was sent: too little ETH for the network fee.",
    );
    // Asked of the very send, as the account that sends it.
    expect(assertOwnGas).toHaveBeenLastCalledWith(BASE, account.address, calls);
    expect(chain.sent).toEqual([]);
    expect(await journalled()).toEqual([]);
  });

  // Its action then stays running, settled from the chain, rather than failing and being sent again.
  it("says a send the node never answered may have gone, and keeps it to send again", async () => {
    const { chain } = fakeChain();
    chain.next.push("no answer");
    const thrown = await sendEvmTransaction(account, BASE, [{ to: ROUTER }], options()).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(MayHaveSent);
    const [row] = await journalled();
    expect((thrown as MayHaveSent).sent).toEqual({
      chain: "base",
      hash: row!.hash,
      walletTxId: row!.id,
    });
    expect(row!.rejectedAt).toBeNull();
  });

  it("marks a send the node refused, so nothing went and its nonce is free again", async () => {
    const { chain, mine } = fakeChain();
    chain.next.push("refused");
    await expect(sendEvmTransaction(account, BASE, [{ to: ROUTER }], options())).rejects.toThrow(
      "Nothing was sent: Base refused it",
    );
    const [refused] = await journalled();
    expect(refused!.rejectedAt).not.toBeNull();

    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x02" }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(2));
    mine();
    await sending;
    expect(chain.sent.map(nonceOf)).toEqual([0, 0]);
  });

  it("takes an error answer for a send the node has as taken", async () => {
    const { chain, mine } = fakeChain();
    chain.next.push("known");
    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(1));
    mine();
    expect(await sending).toBe(kept[0]!.hash);
    expect((await journalled())[0]!.rejectedAt).toBeNull();
  });

  it("gives two moves sent at once a nonce each", async () => {
    const { chain, mine } = fakeChain();
    const one = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x01" }], options());
    const two = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x02" }], options());
    // The second, in its turn, sends the first's again, which changes nothing.
    await vi.waitFor(() => expect(new Set(chain.sent).size).toBe(2));
    mine();
    await Promise.all([one, two]);
    expect([...new Set(chain.sent)].map(nonceOf).toSorted()).toEqual([0, 1]);
    expect((await journalled()).map(({ nonce }) => nonce).toSorted()).toEqual([0, 1]);
  });

  it("sends again what was journalled and never went out, before taking the next nonce", async () => {
    const { chain, mine } = fakeChain();
    // As a crash between the journal and the broadcast leaves it.
    const raw = await journalAt(0);

    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x02" }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(2));
    mine();
    await sending;
    expect(chain.sent[0]).toBe(raw);
    expect(chain.sent.map(nonceOf)).toEqual([0, 1]);
  });

  // Sends take turns until a node answers, so B can't be signed above a nonce A is about to lose.
  it("lets a send pick its nonce only once the one before it was answered", async () => {
    const { chain, mine } = fakeChain();
    chain.next.push("refused");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let keeping = false;
    const a = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x0a" }], {
      ...options(),
      onSent: () => {
        keeping = true;
        return held;
      },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(keeping).toBe(true));
    const b = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x0b" }], options());
    // B waits for A's turn: nothing it signs is journalled while A's answer is still to come.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(chain.sent).toEqual([]);
    release();
    expect(String(await a)).toContain("Nothing was sent: Base refused it");
    await vi.waitFor(() => expect(chain.sent).toHaveLength(2));
    mine();
    await b;
    // A's refusal freed nonce 0 before B picked, so B took it and can land.
    expect(chain.sent.map(nonceOf)).toEqual([0, 0]);
    expect(
      (await journalled()).map(({ nonce, rejectedAt }) => [nonce, rejectedAt !== null]),
    ).toEqual([
      [0, true],
      [0, false],
    ]);
  });

  it("frees the nonce of an earlier send a node now refuses, and takes it", async () => {
    const { chain, mine } = fakeChain();
    // Never answered when first sent, and refused when sent again.
    const raw = await journalAt(0);
    chain.next.push("refused");
    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x02" }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(2));
    mine();
    await sending;
    expect(chain.sent[0]).toBe(raw);
    expect(chain.sent.map(nonceOf)).toEqual([0, 0]);
    const [refused] = await journalled();
    expect(refused!.rejectedAt).not.toBeNull();
  });

  it("fills a nonce a refused send left free below one still on its way", async () => {
    const { chain, mine } = fakeChain();
    await journalAt(0);
    await journalAt(1);
    // Nonce 0 is refused, and nonce 1 goes unanswered, so the node has neither.
    chain.next.push("refused", "no answer");
    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x02" }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(3));
    mine();
    await sending;
    expect(chain.sent.map(nonceOf)).toEqual([0, 1, 0]);
  });

  // Taking it would sign a second send at a nonce the first may yet land at: one of them would go.
  it("never takes the nonce of an earlier send still unanswered, which the node doesn't have", async () => {
    const { chain, mine } = fakeChain();
    const raw = await journalAt(0);
    // Sent again, it goes unanswered once more, so the node's pending count doesn't count it.
    chain.next.push("no answer");
    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x02" }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(2));
    mine();
    await sending;
    expect(chain.sent[0]).toBe(raw);
    expect(chain.sent.map(nonceOf)).toEqual([0, 1]);
  });

  it("sends nothing when its action can't keep it, since the journal writes with it", async () => {
    const { chain } = fakeChain();
    await expect(
      sendEvmTransaction(account, BASE, [{ to: ROUTER }], {
        ...options(),
        onSent: async () => {
          throw new Error("The database went away.");
        },
      }),
    ).rejects.toThrow("The database went away.");
    expect(await journalled()).toEqual([]);
    expect(chain.sent).toEqual([]);
  });
});

// A crash between signing and broadcasting leaves the bytes journalled and unsent; as Auni starts
// again, the wallet sends them (WalletProvider.resend), so the move goes out once, signed once.
describe("resendEvm", () => {
  it("sends what a running move signed and never sent, the same bytes, once", async () => {
    const { chain, mine } = fakeChain();
    const raw = await journalAt(0);
    await resendEvm(account);
    expect(chain.sent).toEqual([raw]);
    mine();
    await resendEvm(account);
    expect(chain.sent).toEqual([raw]);
    expect([...chain.mined].map((hash) => nonceOf(chain.seen.get(hash)!))).toEqual([0]);
    expect(await evmSendStatus((await journalled())[0]!, account)).toEqual({
      hash: keccak256(raw),
    });
  });

  it("leaves the sends of a move that settled alone", async () => {
    const { chain } = fakeChain();
    await journalAt(0);
    await db.update(actions).set({ status: "done", phase: null }).where(eq(actions.id, actionId));
    await resendEvm(account);
    expect(chain.sent).toEqual([]);
  });
});

describe("evmSendStatus", () => {
  const sentOnce = async () => {
    const { chain, mine } = fakeChain();
    chain.next.push("no answer");
    await sendEvmTransaction(account, BASE, [{ to: ROUTER }], options()).catch(() => {});
    const [row] = await journalled();
    return { chain, mine, row: row! };
  };

  it("sends the very same bytes again while the chain hasn't mined it", async () => {
    const { chain, row } = await sentOnce();
    expect(await evmSendStatus(row, account)).toBe("pending");
    expect(chain.sent).toEqual([row.raw, row.raw]);
  });

  it("gives its hash once it landed", async () => {
    const { chain, mine, row } = await sentOnce();
    chain.seen.set(row.hash as Hex, row.raw as Hex);
    mine();
    expect(await evmSendStatus(row, account)).toEqual({ hash: row.hash });
  });

  it("says it failed once another transaction took its nonce", async () => {
    const { chain, row } = await sentOnce();
    chain.latest = 1;
    expect(await evmSendStatus(row, account)).toBe("failed");
    expect(chain.sent).toEqual([row.raw]);
  });

  it("says it failed once a node refuses it when sent again", async () => {
    const { chain, row } = await sentOnce();
    chain.next.push("refused");
    expect(await evmSendStatus(row, account)).toBe("failed");
    expect((await journalled())[0]!.rejectedAt).not.toBeNull();
  });

  it("says it failed when the node refused it", async () => {
    const { row } = await sentOnce();
    await db.update(signedTxs).set({ rejectedAt: new Date() }).where(eq(signedTxs.id, row.id));
    const [refused] = await journalled();
    expect(await evmSendStatus(refused!, account)).toBe("failed");
  });
});

// A send whose fee cap the chain's base fee has passed never lands, and holds every later nonce
// back. Re-signed at a higher fee, the same call at the same nonce, one of the two lands.
describe("a stuck send", () => {
  const stuck = async () => {
    const { chain, mine } = fakeChain();
    const raw = await journalAt(0, 4);
    fees.today = { tip: 3n, baseFee: 50n, maxFee: 103n };
    const [row] = await journalled();
    return { chain, mine, raw, row: row! };
  };

  it("is replaced by fee, journalled before it goes, and its replacement is the move's", async () => {
    const { chain, mine, raw, row } = await stuck();
    expect(await evmSendStatus(row, account)).toBe("pending");

    const [old, replacement] = await journalled();
    expect(old).toMatchObject({ id: row.id, replacedAt: expect.any(Date) });
    expect(replacement).toMatchObject({
      actionId,
      nonce: 0,
      replaces: row.id,
      replacedAt: null,
      rejectedAt: null,
    });
    const before = parseTransaction(raw);
    const after = parseTransaction(replacement!.raw as Hex);
    // The same call, at today's fees.
    expect(after).toMatchObject({
      to: before.to,
      data: before.data,
      value: before.value,
      gas: before.gas,
      nonce: 0,
      type: "eip1559",
      maxFeePerGas: 103n,
      maxPriorityFeePerGas: 3n,
    });
    expect(chain.sent).toEqual([replacement!.raw]);

    mine();
    expect(await evmSendStatus(row, account)).toEqual({ hash: replacement!.hash });
    expect(chain.mined.size).toBe(1);
  });

  it("raises each fee at least an eighth, when today's is barely over", async () => {
    const { row } = await stuck();
    fees.today = { tip: 1n, baseFee: 10n, maxFee: 22n };
    await evmSendStatus(row, account);
    const [, replacement] = await journalled();
    expect(parseTransaction(replacement!.raw as Hex)).toMatchObject({
      maxFeePerGas: 24n,
      maxPriorityFeePerGas: 2n,
    });
  });

  it("goes as it is while it's new, or its fee still fits", async () => {
    const { chain } = fakeChain();
    const fresh = await journalAt(0, 1);
    fees.today = { tip: 3n, baseFee: 50n, maxFee: 103n };
    await resendEvm(account);
    expect(chain.sent).toEqual([fresh]);

    await db.delete(signedTxs);
    const old = await journalAt(0, 10);
    fees.today = { tip: 1n, baseFee: 10n, maxFee: 21n };
    await resendEvm(account);
    expect(chain.sent.at(-1)).toBe(old);
    expect(await journalled()).toHaveLength(1);
  });

  it("goes as it is when the wallet can't pay the higher fee", async () => {
    const { chain, raw, row } = await stuck();
    chain.balance = 21_000n * 103n;
    await evmSendStatus(row, account);
    expect(chain.sent).toEqual([raw]);
    expect(await journalled()).toHaveLength(1);
  });

  it("goes as it is when this wallet no longer holds the key that signed it", async () => {
    const { chain, raw } = await stuck();
    await resendEvm(null);
    await resendEvm(privateKeyToAccount(`0x${"42".repeat(32)}`));
    expect(chain.sent).toEqual([raw, raw]);
    expect(await journalled()).toHaveLength(1);
  });

  it("holds its nonce again, and goes as it is, when a node refuses the replacement", async () => {
    const { chain, raw, row } = await stuck();
    chain.next.push("refused");
    expect(await evmSendStatus(row, account)).toBe("pending");
    const [old, refused] = await journalled();
    expect(old).toMatchObject({ replacedAt: null, rejectedAt: null });
    expect(refused!.rejectedAt).not.toBeNull();
    expect(chain.sent.at(-1)).toBe(raw);
  });

  it("is replaced at most three times", async () => {
    const { row } = await stuck();
    for (let round = 0; round < 5; round += 1) {
      // Each replacement is stuck in its turn once it's old and today's fee has risen past it.
      await db.update(signedTxs).set({ createdAt: new Date(Date.now() - 10 * 60_000) });
      fees.today = {
        tip: fees.today.tip * 2n,
        baseFee: fees.today.baseFee * 2n,
        maxFee: fees.today.maxFee * 2n,
      };
      await evmSendStatus(row, account);
    }
    const sends = await journalled();
    expect(sends).toHaveLength(4);
    expect(sends.filter(({ replacedAt }) => replacedAt === null)).toHaveLength(1);
  });

  it("landed as it was still counts, by its own hash", async () => {
    const { chain, mine, raw, row } = await stuck();
    // The node mined the first before it saw the replacement.
    chain.seen.set(keccak256(raw), raw);
    mine();
    expect(await evmSendStatus(row, account)).toEqual({ hash: row.hash });
  });

  it("is replaced before the account's next send takes the nonce after it", async () => {
    const { chain, mine } = await stuck();
    const sending = sendEvmTransaction(account, BASE, [{ to: ROUTER, data: "0x02" }], options());
    await vi.waitFor(() => expect(chain.sent).toHaveLength(2));
    mine();
    await sending;
    const [, replacement, next] = await journalled();
    expect(chain.sent).toEqual([replacement!.raw, next!.raw]);
    expect(chain.sent.map(nonceOf)).toEqual([0, 1]);
  });
});
