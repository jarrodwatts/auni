import { NETWORKS } from "@auni/shared";
import { eq } from "drizzle-orm";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  parseGwei,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../db/client.ts";
import { actions } from "../../db/schema.ts";
import { signedTxs } from "./tables.ts";
import { evmClient } from "../../money/chains.ts";
import { insertAction, wipe } from "../../test/db.ts";
import { DELEGATOR, evmSendStatus, sendEvmTransaction } from "./evm.ts";

// Against an anvil fork of Monad mainnet, where the real DeleGator runs:
//   anvil --fork-url https://rpc2.monad.xyz --port 8547
//   AUNI_FORK_RPC=http://127.0.0.1:8547 pnpm --filter @auni/core test:db evm.fork
const FORK = process.env.AUNI_FORK_RPC;

vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original()),
  evmClient: vi.fn(),
}));

const MONAD = NETWORKS.monad.viem;
const client = createPublicClient({ chain: MONAD, transport: http(FORK), pollingInterval: 100 });

const ERC20 = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

// Each read of state the fork hasn't seen yet goes to Monad itself, so it takes its time.
describe.skipIf(!FORK)("a list of calls on Monad", { timeout: 120_000 }, () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const [one, two] = [
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
  ];
  const balance = (address: Address) => client.getBalance({ address });
  let actionId = "";

  beforeEach(async () => {
    vi.mocked(evmClient).mockReturnValue(client as never);
    await wipe(actions, signedTxs);
    actionId = (await insertAction()).id;
    await client.request({
      method: "anvil_setBalance" as never,
      params: [account.address, `0x${parseEther("100").toString(16)}`] as never,
    });
  });

  const send = (calls: { to: string; data?: string; value?: string }[]) =>
    sendEvmTransaction(account, MONAD.id, calls, { actionId, attempt: 1, onSent: async () => {} });

  it("goes as one transaction that delegates the account to the DeleGator, then without", async () => {
    const hash = await send([
      { to: one.address, value: parseEther("1").toString() },
      { to: two.address, value: parseEther("2").toString() },
    ]);

    expect(await balance(one.address)).toBe(parseEther("1"));
    expect(await balance(two.address)).toBe(parseEther("2"));
    expect((await client.getTransaction({ hash: hash as `0x${string}` })).type).toBe("eip7702");
    expect(await client.getCode({ address: account.address })).toBe(
      `0xef0100${DELEGATOR.slice(2).toLowerCase()}`,
    );

    const again = await send([
      { to: one.address, value: parseEther("1").toString() },
      { to: two.address, value: parseEther("1").toString() },
    ]);
    expect((await client.getTransaction({ hash: again as `0x${string}` })).type).toBe("eip1559");
    expect(await balance(one.address)).toBe(parseEther("2"));
  });

  it("moves nothing when any call in it would revert", async () => {
    const before = await balance(one.address);
    // A transfer of USDC the account doesn't hold reverts, and takes the first call with it.
    const reverting = {
      to: NETWORKS.monad.usdc,
      data: encodeFunctionData({
        abi: ERC20,
        functionName: "transfer",
        args: [two.address, 1_000_000n],
      }),
    };
    await expect(
      send([{ to: one.address, value: parseEther("1").toString() }, reverting]),
    ).rejects.toThrow();
    expect(await balance(one.address)).toBe(before);
  });
});

// Monad doesn't document how much a replacement must raise its fees; geth asks a tenth, and
// replaceStuck raises an eighth. Proved here on anvil, which holds a replacement to the same rule.
describe.skipIf(!FORK)("a send stuck behind its fee cap on Monad", { timeout: 120_000 }, () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const anvil = (method: string, params: unknown[] = []) =>
    client.request({ method: method as never, params: params as never });

  beforeEach(async () => {
    vi.mocked(evmClient).mockReturnValue(client as never);
    await wipe(actions, signedTxs);
    await anvil("anvil_setBalance", [account.address, `0x${parseEther("100").toString(16)}`]);
  });

  it("is replaced by fee, the same call at the same nonce, and the replacement lands once", async () => {
    const actionId = (await insertAction()).id;
    const nonce = await client.getTransactionCount({ address: account.address });
    const block = await client.getBlock();
    const cap = (block.baseFeePerGas ?? parseGwei("1")) + parseGwei("1");
    const raw = await account.signTransaction({
      chainId: MONAD.id,
      nonce,
      to,
      value: parseEther("1"),
      gas: 21_000n,
      maxFeePerGas: cap,
      maxPriorityFeePerGas: parseGwei("1"),
    });
    // Journalled four minutes ago and taken by the pool, then the base fee rose past its cap.
    const [row] = await db
      .insert(signedTxs)
      .values({
        actionId,
        chain: "monad",
        address: account.address,
        nonce,
        raw,
        hash: keccak256(raw),
        createdAt: new Date(Date.now() - 4 * 60_000),
      })
      .returning();
    await anvil("evm_setAutomine", [false]);
    try {
      await client.sendRawTransaction({ serializedTransaction: raw });
      await anvil("anvil_setNextBlockBaseFeePerGas", [`0x${(cap * 4n).toString(16)}`]);
      await anvil("evm_mine");
      expect(await client.getTransactionCount({ address: account.address })).toBe(nonce);

      expect(await evmSendStatus(row!, account)).toBe("pending");
      const [, replacement] = await db
        .select()
        .from(signedTxs)
        .where(eq(signedTxs.actionId, actionId))
        .orderBy(signedTxs.createdAt);
      expect(replacement).toMatchObject({ nonce, replaces: row!.id });
      await anvil("evm_mine");

      expect(await evmSendStatus(row!, account)).toEqual({ hash: replacement!.hash });
      const landed = await client.getTransaction({ hash: replacement!.hash as Hex });
      expect(landed).toMatchObject({ nonce, to: to.toLowerCase(), value: parseEther("1") });
      expect(landed.maxFeePerGas).toBeGreaterThan(cap * 4n);
      expect(await client.getBalance({ address: to })).toBe(parseEther("1"));
      expect(await client.getTransactionCount({ address: account.address })).toBe(nonce + 1);
    } finally {
      await anvil("evm_setAutomine", [true]);
    }
  });
});
