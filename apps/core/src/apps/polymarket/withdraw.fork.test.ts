import { NETWORKS } from "@auni/shared";
import {
  createTestClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  pad,
  parseAbi,
  parseEther,
  publicActions,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { approvedDetails } from "../../money/actions.ts";
import { APPROVED_PROCEEDS } from "../../money/approved.ts";
import { evmClient, publicClient } from "../../money/chains.ts";
import type { KeptTx } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import { signTyped } from "../../money/typed-data.ts";
import { walletEffect } from "../../money/wallet-effect.ts";
import { evmAddress } from "../../money/wallets.ts";
import { walletsFor } from "../../test/wallets.ts";
import { CONTRACTS, relayerRequest } from "./http.ts";
import { batchTypedData } from "./relayer.ts";
import { depositWallet, type Call } from "./wallet.ts";
import { homeCalls, polymarketWithdraw, SWAP_ROUTER } from "./withdraw.ts";

// Bringing Polymarket cash home on an anvil fork of Polygon, where Polymarket's real factory,
// deposit wallet, pUSD, onramp and offramp run, and the real Uniswap pool. The recipe is the
// real one, start to finish: its card is drawn from the batch run first on the fork, and its
// run signs the batch with a key made here. One thing is stood in for: Polymarket's relayer,
// whose whole part on chain is to have one of its operator keys call the factory's `proxy`
// with the signed batch, which the stand-in does from a real operator's address.
//
//   anvil --fork-url https://polygon.gateway.tenderly.co --port 4510
//   AUNI_POLYGON_FORK_RPC=http://127.0.0.1:4510 pnpm --filter @auni/core exec vitest run withdraw.fork
//
// What no fork shows is the relayer's own answer to this batch from a builder's keys; a
// transaction on Polygon shows it carries these four calls (fixtures/cash-home-relayed.json).
const FORK = process.env.AUNI_POLYGON_FORK_RPC;

vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: vi.fn(),
  publicClient: vi.fn(),
  publicRpcClient: () => null,
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(),
}));
vi.mock(import("./http.ts"), async (original) => ({
  ...(await original()),
  relayerRequest: vi.fn(),
}));

/** One of the keys Polymarket's relayer sends from, which the factory lets call `proxy`. */
const OPERATOR: Address = "0xa16cb225cdfe416fdd8faf75c12d16533cd1fdfd";
/** Where pUSD's backing is kept: the fork's donor of USDC.e. */
const VAULT: Address = "0xC417fD8E9661c0d2120B64a04Bb3278C17E99DB1";
const POOL: Address = "0xD36ec33c8bed5a9F7B6630855f1533455b98a418";

const factoryAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "struct Batch { address wallet; uint256 nonce; uint256 deadline; Call[] calls; }",
  "function proxy(Batch[] batches, bytes[] signatures)",
  "function deploy(address[] owners, bytes32[] ids)",
  "function isOperator(address operator) view returns (bool)",
]);
const walletAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function owner() view returns (address)",
]);
const rampAbi = parseAbi([
  "function wrap(address asset, address to, uint256 amount)",
  "function pause(address asset)",
  "function unpause(address asset)",
  "function owner() view returns (address)",
  "function grantRoles(address user, uint256 roles) payable",
]);

describe.skipIf(!FORK)(
  "bringing Polymarket cash home, on a fork of Polygon",
  { timeout: 240_000 },
  () => {
    const fork = createTestClient({
      chain: NETWORKS.polygon.viem,
      mode: "anvil",
      transport: http(FORK),
      pollingInterval: 100,
    }).extend(publicActions);
    const key = generatePrivateKey();
    const owner = privateKeyToAccount(key).address;
    const wallets = walletsFor(key);
    let wallet: Address;
    /** The batch the stand-in relayer last had the factory run, and the owner's signature of it. */
    let relayed: { readonly batch: Batch; readonly signature: Hex } | null = null;

    interface Batch {
      readonly wallet: Address;
      readonly nonce: bigint;
      readonly deadline: bigint;
      readonly calls: readonly {
        readonly target: Address;
        readonly value: bigint;
        readonly data: Hex;
      }[];
    }

    /** Sends a transaction as `from`, which the fork lets anyone be, and waits for it. */
    async function sendAs(from: Address, to: Address, data: Hex) {
      await fork.setBalance({ address: from, value: parseEther("100") });
      await fork.impersonateAccount({ address: from });
      const hash = await fork.sendUnsignedTransaction({ from, to, data });
      return fork.waitForTransactionReceipt({ hash });
    }
    /** What the relayer does on chain: an operator has the factory run the signed batch. */
    const proxy = (batch: Batch, signature: Hex) =>
      sendAs(
        OPERATOR,
        CONTRACTS.walletFactory,
        encodeFunctionData({
          abi: factoryAbi,
          functionName: "proxy",
          args: [[batch], [signature]],
        }),
      );
    const balance = (token: Address, holder: Address) =>
      fork.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
      });
    const allowance = (token: Address, spender: Address) =>
      fork.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet, spender],
      });
    const walletNonce = () =>
      fork.readContract({ address: wallet, abi: walletAbi, functionName: "nonce" });
    /** A batch of `calls` at the wallet's next nonce, signed by `signer`. */
    async function signedBatch(calls: readonly Call[], signer = wallets) {
      const batch: Batch = {
        wallet,
        nonce: await walletNonce(),
        deadline: (await fork.getBlock()).timestamp + 600n,
        calls: calls.map(({ target, data }) => ({ target, value: 0n, data })),
      };
      const typed = batchTypedData(wallet, batch.nonce, batch.deadline, calls);
      // signTyped checks the signature is the owner's, which another key's must get past here.
      const signature =
        signer === wallets
          ? await signTyped(signer, typed)
          : ((await signer.signEvmTypedData(typed as never)) as Hex);
      return { batch, signature };
    }
    /** The card a call draws, as the action row execute is handed. */
    async function cardFor(input: { amountUsd?: number }) {
      const preview = await polymarketWithdraw.describe(input, {});
      return {
        preview,
        action: { amountUsd: preview.amountUsd, details: approvedDetails(preview) } as ActionRow,
      };
    }
    const run = (action: ActionRow, kept: KeptTx[] = []) =>
      polymarketWithdraw.execute({
        input: {},
        action,
        wallets,
        recordSent: async (tx) => void kept.push(tx),
        posting: (_chain, post) => post(),
      });

    beforeAll(async () => {
      vi.mocked(evmClient).mockReturnValue(fork as never);
      vi.mocked(publicClient).mockReturnValue(fork as never);
      vi.mocked(evmAddress).mockResolvedValue(owner);
      // The relayer's three answers, with its part on chain played by a real operator's address.
      vi.mocked(relayerRequest).mockImplementation(async (method, path, _query, body) => {
        if (path === "/v1/account/transactions/params")
          return { nonce: String(await walletNonce()) };
        if (method === "POST" && path === "/submit") {
          const sent = JSON.parse(body!) as {
            nonce: string;
            signature: Hex;
            depositWalletParams: {
              depositWallet: Address;
              deadline: string;
              calls: { target: Address; value: string; data: Hex }[];
            };
          };
          const { depositWallet: to, deadline, calls } = sent.depositWalletParams;
          const batch: Batch = {
            wallet: to,
            nonce: BigInt(sent.nonce),
            deadline: BigInt(deadline),
            calls: calls.map((call) => ({ ...call, value: BigInt(call.value) })),
          };
          relayed = { batch, signature: sent.signature };
          return { transactionID: (await proxy(batch, sent.signature)).transactionHash };
        }
        const hash = path.split("/").at(-1) as Hex;
        const { status } = await fork.getTransactionReceipt({ hash });
        return {
          state: status === "success" ? "STATE_CONFIRMED" : "STATE_FAILED",
          transaction_hash: hash,
        };
      });

      expect(
        await fork.readContract({
          address: CONTRACTS.walletFactory,
          abi: factoryAbi,
          functionName: "isOperator",
          args: [OPERATOR],
        }),
      ).toBe(true);
      // The owner's deposit wallet, made as the relayer makes one, where the app looks for it.
      await sendAs(
        OPERATOR,
        CONTRACTS.walletFactory,
        encodeFunctionData({
          abi: factoryAbi,
          functionName: "deploy",
          args: [[owner], [pad(owner.toLowerCase() as Hex, { size: 32 })]],
        }),
      );
      const made = await depositWallet(owner);
      expect(made.deployed).toBe(true);
      wallet = made.address;
      expect(
        await fork.readContract({ address: wallet, abi: walletAbi, functionName: "owner" }),
      ).toBe(owner);
      // $50 of pUSD in it, minted by Polymarket's own onramp from USDC.e, as a buy's funding is.
      const fifty = 50_000_000n;
      await sendAs(
        VAULT,
        CONTRACTS.usdce,
        encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, fifty] }),
      );
      await sendAs(
        owner,
        CONTRACTS.usdce,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [CONTRACTS.collateralOnramp, fifty],
        }),
      );
      await sendAs(
        owner,
        CONTRACTS.collateralOnramp,
        encodeFunctionData({
          abi: rampAbi,
          functionName: "wrap",
          args: [CONTRACTS.usdce, wallet, fifty],
        }),
      );
      expect(await balance(CONTRACTS.pusd, wallet)).toBe(fifty);
    }, 120_000);

    it("brings exactly the card's dollars to the owner's own wallet as USDC, and leaves nothing behind", async () => {
      const { action } = await cardFor({ amountUsd: 20 });
      const least = BigInt(Math.round(Number(action.details[APPROVED_PROCEEDS]) * 1e6));
      const before = await balance(CONTRACTS.usdc, owner);
      const kept: KeptTx[] = [];

      const { txs } = await run(action, kept);

      const hash = txs[0]!.hash as Hex;
      expect(kept).toEqual([
        { chain: "polygon", relayerId: hash },
        { chain: "polygon", relayerId: hash, hash },
      ]);
      const receipt = await fork.getTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      expect(getAddress(receipt.to!)).toBe(CONTRACTS.walletFactory);
      // Exactly $20 of pUSD left the deposit wallet, and none of what it became stayed there.
      expect(await balance(CONTRACTS.pusd, wallet)).toBe(30_000_000n);
      expect(await balance(CONTRACTS.usdce, wallet)).toBe(0n);
      expect(await balance(CONTRACTS.usdc, wallet)).toBe(0n);
      // The owner's own wallet got the USDC: no less than the card's least, and what the card
      // said the pool pays, since nothing traded there in between.
      const got = (await balance(CONTRACTS.usdc, owner)) - before;
      expect(got).toBeGreaterThanOrEqual(least);
      expect(least).toBe((got * 9_990n) / 10_000n);
      expect(got).toBeGreaterThan(19_980_000n);
      expect(walletEffect(receipt.logs, owner)).toMatchObject({
        out: [],
        in: [{ token: CONTRACTS.usdc, amount: got }],
        grants: [],
      });
      // The deposit wallet paid pUSD's own contract, which burned it, and the pool: no one else.
      expect(walletEffect(receipt.logs, wallet).sentTo).toEqual([CONTRACTS.pusd, POOL]);
      // No permission outlives it: each approval was spent whole.
      expect(await allowance(CONTRACTS.pusd, CONTRACTS.collateralOfframp)).toBe(0n);
      expect(await allowance(CONTRACTS.usdce, SWAP_ROUTER)).toBe(0n);
      expect(await walletNonce()).toBe(1n);
    });

    it("can't be run a second time: the wallet takes each signed batch once", async () => {
      const [pusd, usdc] = [
        await balance(CONTRACTS.pusd, wallet),
        await balance(CONTRACTS.usdc, owner),
      ];
      expect((await proxy(relayed!.batch, relayed!.signature)).status).toBe("reverted");
      expect(await balance(CONTRACTS.pusd, wallet)).toBe(pusd);
      expect(await balance(CONTRACTS.usdc, owner)).toBe(usdc);
      expect(await walletNonce()).toBe(1n);
    });

    it("moves nothing at all when the pool pays under the least the batch asks", async () => {
      const pusd = await balance(CONTRACTS.pusd, wallet);
      // A dollar of USDC for each dollar in, which the pool's fee alone rules out.
      const greedy = await signedBatch(homeCalls(wallet, owner, 10_000_000n, 10_000_000n));
      expect((await proxy(greedy.batch, greedy.signature)).status).toBe("reverted");
      expect(await balance(CONTRACTS.pusd, wallet)).toBe(pusd);
      expect(await balance(CONTRACTS.usdce, wallet)).toBe(0n);
      expect(await allowance(CONTRACTS.pusd, CONTRACTS.collateralOfframp)).toBe(0n);
      // The recipe meets the same refusal when it runs the batch first, and signs nothing.
      const { action } = await cardFor({ amountUsd: 10 });
      const asksMore = { ...action, details: { ...action.details, [APPROVED_PROCEEDS]: "10" } };
      const refused = await run(asksMore as ActionRow).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(Refused);
      expect((refused as Refused).kind).toBe("price");
      expect(await balance(CONTRACTS.pusd, wallet)).toBe(pusd);
    });

    it("runs nothing for a batch any key but the owner's signed", async () => {
      const pusd = await balance(CONTRACTS.pusd, wallet);
      const stranger = walletsFor(generatePrivateKey());
      const forged = await signedBatch(
        homeCalls(wallet, getAddress(stranger.evmAddress), 10_000_000n, 0n),
        stranger,
      );
      expect((await proxy(forged.batch, forged.signature)).status).toBe("reverted");
      expect(await balance(CONTRACTS.pusd, wallet)).toBe(pusd);
    });

    it("brings all of it when asked", async () => {
      const { action } = await cardFor({});
      expect(action.amountUsd).toBe("30.00");
      const before = await balance(CONTRACTS.usdc, owner);
      await run(action);
      expect(await balance(CONTRACTS.pusd, wallet)).toBe(0n);
      expect((await balance(CONTRACTS.usdc, owner)) - before).toBeGreaterThan(29_970_000n);
      await expect(polymarketWithdraw.describe({}, {})).rejects.toThrow(
        "Your Polymarket wallet holds no cash to bring back.",
      );
    });

    it("offers no card while Polymarket has its offramp paused, in the owner's words", async () => {
      // A little cash to ask for, then the offramp's own owner pauses USDC.e on it.
      await sendAs(
        VAULT,
        CONTRACTS.usdce,
        encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, 5_000_000n] }),
      );
      await sendAs(
        owner,
        CONTRACTS.usdce,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [CONTRACTS.collateralOnramp, 5_000_000n],
        }),
      );
      await sendAs(
        owner,
        CONTRACTS.collateralOnramp,
        encodeFunctionData({
          abi: rampAbi,
          functionName: "wrap",
          args: [CONTRACTS.usdce, wallet, 5_000_000n],
        }),
      );
      const admin = await fork.readContract({
        address: CONTRACTS.collateralOfframp,
        abi: rampAbi,
        functionName: "owner",
      });
      await sendAs(
        admin,
        CONTRACTS.collateralOfframp,
        encodeFunctionData({ abi: rampAbi, functionName: "grantRoles", args: [admin, 1n] }),
      );
      await sendAs(
        admin,
        CONTRACTS.collateralOfframp,
        encodeFunctionData({ abi: rampAbi, functionName: "pause", args: [CONTRACTS.usdce] }),
      );
      const paused = await polymarketWithdraw
        .describe({ amountUsd: 5 }, {})
        .catch((error) => error);
      expect(paused).toBeInstanceOf(Refused);
      expect((paused as Error).message).toContain("has paused turning its dollars back into USDC");
      await sendAs(
        admin,
        CONTRACTS.collateralOfframp,
        encodeFunctionData({ abi: rampAbi, functionName: "unpause", args: [CONTRACTS.usdce] }),
      );
      expect((await cardFor({ amountUsd: 5 })).action.amountUsd).toBe("5.00");
    });
  },
);
