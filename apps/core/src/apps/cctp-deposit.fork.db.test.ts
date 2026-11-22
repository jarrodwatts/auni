import { NETWORKS } from "@auni/shared";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  pad,
  parseAbi,
  parseEther,
  parseEventLogs,
  parseUnits,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { actions } from "../db/schema.ts";
import { evmClient } from "../money/chains.ts";
import { insertAction, wipe } from "../test/db.ts";
import {
  burnCalls,
  FORWARDER,
  forwardHook,
  forwardingFee,
  TOKEN_MESSENGER,
} from "./hyperliquid/cctp.ts";
import { sendEvmTransaction } from "./local-key/evm.ts";
import { signedTxs } from "./local-key/tables.ts";

// The Arbitrum half of a deposit into Hyperliquid by CCTP, on an anvil fork of Arbitrum, where
// Circle's real TokenMessengerV2 and the real USDC run. Two apps meet here, which is why this
// sits beside them and not in either's folder: the calls are Hyperliquid's (hyperliquid/cctp.ts)
// and they are sent as the owner's own wallet sends a list of calls (local-key/evm.ts).
//   anvil --fork-url https://arb1.arbitrum.io/rpc --port 4358
//   AUNI_ARBITRUM_FORK_RPC=http://127.0.0.1:4358 pnpm --filter @auni/core test:db cctp-deposit
// It reads Circle's fee from Circle's own API. What happens after the burn (Circle's
// attestation, the mint on HyperEVM, the credit on Hyperliquid) no fork can run: see
// hyperliquid/cctp.test.ts for that half, against a real deposit's records.
const FORK = process.env.AUNI_ARBITRUM_FORK_RPC;

vi.mock("../money/chains.ts", async (original) => ({
  ...(await original<object>()),
  evmClient: vi.fn(),
}));

const ARBITRUM = NETWORKS.arbitrum.viem;
const USDC = NETWORKS.arbitrum.usdc as Address;
const client = createPublicClient({ chain: ARBITRUM, transport: http(FORK), pollingInterval: 100 });
const anvil = (method: string, params: unknown[]) =>
  client.request({ method: method as never, params: params as never });

/** Hyperliquid's bridge, which holds more USDC than anyone on Arbitrum: the fork's donor. */
const DONOR: Address = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
const burned = parseAbi([
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

describe.skipIf(!FORK)("a deposit by CCTP, as far as Arbitrum", { timeout: 180_000 }, () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const usdc = <Name extends "balanceOf" | "allowance" | "totalSupply">(
    functionName: Name,
    args: readonly Address[] = [],
  ) => client.readContract({ address: USDC, abi: erc20Abi, functionName, args } as never);
  let actionId = "";

  beforeEach(async () => {
    vi.mocked(evmClient).mockReturnValue(client as never);
    await wipe(actions, signedTxs);
    actionId = (await insertAction()).id;
    await anvil("anvil_setBalance", [account.address, `0x${parseEther("1").toString(16)}`]);
  });

  /** Gives the wallet `amount` of real USDC on the fork, from the donor. */
  async function fund(amount: bigint) {
    await anvil("anvil_setBalance", [DONOR, `0x${parseEther("1").toString(16)}`]);
    await anvil("anvil_impersonateAccount", [DONOR]);
    const hash = await anvil("eth_sendTransaction", [
      {
        from: DONOR,
        to: USDC,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [account.address, amount],
        }),
      },
    ]);
    await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });
  }

  const send = (amount: bigint, fee: bigint) =>
    sendEvmTransaction(account, ARBITRUM.id, burnCalls(account.address, amount, fee), {
      actionId,
      attempt: 1,
      onSent: async () => {},
    });

  it("burns exactly the amount for the owner's own account, in one transaction that leaves nothing approved", async () => {
    const amount = parseUnits("10", 6);
    await fund(parseUnits("25", 6));
    const fee = await forwardingFee(amount);
    const supply = (await usdc("totalSupply")) as bigint;

    const hash = await send(amount, fee);
    const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
    expect(receipt.status).toBe("success");

    // Circle's messenger took the burn as Auni built it: the forwarder as the mint's
    // recipient and its only caller, HyperEVM as where it goes, and the owner's own account.
    const events = parseEventLogs({ abi: burned, logs: receipt.logs }).filter(
      ({ address }) => address.toLowerCase() === TOKEN_MESSENGER.toLowerCase(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.args).toMatchObject({
      burnToken: USDC,
      amount,
      depositor: account.address,
      mintRecipient: pad(FORWARDER).toLowerCase(),
      destinationDomain: 19,
      destinationCaller: pad(FORWARDER).toLowerCase(),
      maxFee: fee,
      minFinalityThreshold: 1000,
      hookData: forwardHook(account.address),
    });
    // The wallet is down exactly the amount, the USDC is gone from Arbitrum (burned, not
    // held by anyone), and the messenger is left approved for nothing.
    expect(await usdc("balanceOf", [account.address])).toBe(parseUnits("15", 6));
    expect(await usdc("totalSupply")).toBe(supply - amount);
    expect(await usdc("allowance", [account.address, TOKEN_MESSENGER])).toBe(0n);
  });

  it("moves nothing, and approves nothing, when the wallet holds less than it sends", async () => {
    const held = (await usdc("balanceOf", [account.address])) as bigint;
    await expect(send(held + 1n, 200_000n)).rejects.toThrow();
    expect(await usdc("balanceOf", [account.address])).toBe(held);
    expect(await usdc("allowance", [account.address, TOKEN_MESSENGER])).toBe(0n);
  });
});
