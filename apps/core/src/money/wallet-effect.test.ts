import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  zeroAddress,
  pad,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { approvedEffect, assertStillAsShown } from "./approved.ts";
import { approval as approvalOf } from "./effect.ts";
import { rawEffect } from "./raw-transaction.ts";
import { revertOf } from "./refused.ts";
import { evmRawEffect } from "./recipes/evm.ts";
import { simulateEffect, walletEffect, type SimulatedEffect } from "./wallet-effect.ts";

/** Alchemy's RPC and the chain's public one, as a test sets them. */
const rpcs: { alchemy: object; public: object | null } = { alchemy: {}, public: null };
const estimateFeesPerGas = async () => ({ maxFeePerGas: 30n, maxPriorityFeePerGas: 2n });

vi.mock("./chains.ts", async (original) => ({
  ...(await original()),
  evmClient: () => rpcs.alchemy,
  publicRpcClient: () => rpcs.public,
}));

beforeEach(() => {
  rpcs.alchemy = { simulateBlocks, estimateFeesPerGas, getCode };
  rpcs.public = null;
});

const OWNER: Address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ROUTER: Address = "0x2222222222222222222222222222222222222222";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const FAKE: Address = "0x3333333333333333333333333333333333333333";
const LENDER: Address = "0x4444444444444444444444444444444444444444";
const POSITIONS: Address = "0x5555555555555555555555555555555555555555";
const DISTRIBUTOR: Address = "0x6666666666666666666666666666666666666666";
const FRIEND: Address = "0x7777777777777777777777777777777777777777";
const DELEGATED: Address = "0x8888888888888888888888888888888888888888";
const names = new Map([
  [USDC, { symbol: "USDC", decimals: 6, usd: 1 }],
  [TOKEN, { symbol: "PRL", decimals: 0, usd: 1 }],
]);

function log(address: Address, signature: string, topics: Hex[], data: Hex = "0x"): Log {
  return { address, topics: [toEventSelector(signature), ...topics], data } as unknown as Log;
}
const word = (value: bigint | boolean) =>
  encodeAbiParameters([{ type: typeof value === "boolean" ? "bool" : "uint256" }], [value]);
const transfer = (token: Address, from: Address, to: Address, amount: bigint) =>
  log(token, "Transfer(address,address,uint256)", [pad(from), pad(to)], word(amount));
const approval = (spender: Address, amount = 5_000_000n) =>
  log(USDC, "Approval(address,address,uint256)", [pad(OWNER), pad(spender)], word(amount));
// ERC-777 indexes the operator before the holder.
const erc777 = (operator: Address, authorized: boolean) =>
  log(TOKEN, `${authorized ? "Authorized" : "Revoked"}Operator(address,address)`, [
    pad(operator),
    pad(OWNER),
  ]);

// An NFT indexes its token id as a fourth topic; ERC-1155 puts the id and amount in its data.
const nft = (from: Address, to: Address, id: bigint) =>
  log(FAKE, "Transfer(address,address,uint256)", [pad(from), pad(to), pad(`0x${id.toString(16)}`)]);
const single = (from: Address, to: Address, id: bigint, amount: bigint) =>
  log(
    FAKE,
    "TransferSingle(address,address,address,uint256,uint256)",
    [pad(OWNER), pad(from), pad(to)],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [id, amount]),
  );

const swap = [transfer(USDC, OWNER, ROUTER, 5_000_000n), transfer(TOKEN, ROUTER, OWNER, 9n)];
/** What a simulation saw the logs do, everyone they sent to an account that keeps it. */
const effect = (logs: Log[]): SimulatedEffect => ({
  ...walletEffect(logs, OWNER),
  blind: false,
  logs,
});
type Calls = { to: string; data?: string }[];

/** How a person approves a batch the agent wrote, by the ladder in effect.ts. */
const ladder = (given: SimulatedEffect | null, known: readonly string[] = []) => {
  const decided = approvalOf(evmRawEffect(given, names), known);
  return decided.kind === "tap" ? "tap" : `${decided.kind}: ${decided.reason}`;
};

// What the batch does decides it: what comes back vouches for what goes only when it lands in the
// wallet, priced, and worth at least half of it.
describe("the approval ladder for a raw batch", () => {
  it.each<[string, SimulatedEffect | null, string]>([
    ["a swap goes on a tap", effect(swap), "tap"],
    [
      "a send to somewhere new takes the owner's proof",
      effect([transfer(USDC, OWNER, ROUTER, 5_000_000n)]),
      "proof: sends money to 0x2222…2222, where you've never sent before",
    ],
    [
      "an allowance left behind takes the owner's proof",
      effect([approval(ROUTER), ...swap]),
      "proof: lets 0x2222…2222 spend your USDC",
    ],
    [
      "approving an operator for a whole collection takes the owner's proof",
      effect([
        log(TOKEN, "ApprovalForAll(address,address,bool)", [pad(OWNER), pad(ROUTER)], word(true)),
      ]),
      "proof: lets 0x2222…2222 move all your PRL",
    ],
    [
      "authorizing an ERC-777 operator takes the owner's proof",
      effect([erc777(ROUTER, true)]),
      "proof: lets 0x2222…2222 move all your PRL",
    ],
    [
      "an ERC-777 operator the batch revokes goes on a tap",
      effect([erc777(ROUTER, true), erc777(ROUTER, false)]),
      "tap",
    ],
    [
      // As burning an NFT, or clearing its approval, logs.
      "an approval to no one leaves nothing behind",
      effect([
        log(TOKEN, "Approval(address,address,uint256)", [pad(OWNER), pad(zeroAddress), pad("0x1")]),
        ...swap,
      ]),
      "tap",
    ],
    [
      "a call that left no trace Auni reads takes the owner's proof",
      { ...effect(swap), blind: true },
      "proof: does something Auni can't see",
    ],
    [
      // One NFT coming back never cancels out another that left, and neither has a price.
      "one NFT traded for another takes the owner's proof",
      effect([nft(OWNER, ROUTER, 1n), nft(ROUTER, OWNER, 2n)]),
      "proof: moves 0x3333…3333, which Auni can't price",
    ],
    [
      "as does one in an ERC-1155 collection, beside a trade",
      effect([...swap, single(OWNER, ROUTER, 1n, 10n), single(ROUTER, OWNER, 2n, 10n)]),
      "proof: moves 0x3333…3333, which Auni can't price",
    ],
    [
      "a little of a send coming back still leaves the rest somewhere new",
      effect([transfer(USDC, OWNER, ROUTER, 5_000_000n), transfer(USDC, ROUTER, OWNER, 1n)]),
      "proof: sends money to 0x2222…2222, where you've never sent before",
    ],
    [
      // Anyone can mint a token for nothing, so one Auni can't price vouches for nothing sent.
      "a token Auni can't price coming back takes the owner's proof",
      effect([transfer(USDC, OWNER, ROUTER, 5_000_000n), transfer(FAKE, ROUTER, OWNER, 9n)]),
      "proof: moves 0x3333…3333, which Auni can't price",
    ],
    [
      "a token Auni can't price leaving takes the owner's proof",
      effect([transfer(FAKE, OWNER, ROUTER, 9n), transfer(USDC, ROUTER, OWNER, 5_000_000n)]),
      "proof: moves 0x3333…3333, which Auni can't price",
    ],
    [
      // The agent's bytes name no least they get, so dust back is money leaving by another name.
      "dust coming back takes the owner's proof",
      effect([transfer(USDC, OWNER, ROUTER, 5_000_000n), transfer(TOKEN, ROUTER, OWNER, 1n)]),
      "proof: brings back PRL, worth under half of what it sends",
    ],
    [
      "one that couldn't be simulated takes the owner's proof",
      null,
      "proof: can't be checked in a simulation",
    ],
  ])("%s", (_name, given, decided) => {
    expect(ladder(given)).toBe(decided);
  });

  it("lets a send go on a tap to where the owner has sent before, in any case", () => {
    const send = effect([transfer(USDC, OWNER, ROUTER, 5_000_000n)]);
    expect(ladder(send, [ROUTER.toUpperCase().replace("0X", "0x")])).toBe("tap");
  });

  it("says on the card what coming back short loses at market prices", () => {
    const dust = evmRawEffect(
      effect([transfer(USDC, OWNER, ROUTER, 5_000_000n), transfer(TOKEN, ROUTER, OWNER, 1n)]),
      names,
    );
    expect(dust.costs).toEqual([{ label: "lost at market prices", usd: 4 }]);
  });
});

// Apps whose one call logs the same whatever it's sent.
const apps = new Map<string, Log[]>([
  // Compound's withdrawTo: collateral the app holds leaves straight to someone else.
  [
    LENDER,
    [
      transfer(TOKEN, LENDER, FAKE, 9n),
      log(LENDER, "WithdrawCollateral(address,address,address,uint256)", [
        pad(OWNER),
        pad(FAKE),
        pad(TOKEN),
      ]),
    ],
  ],
  // A position manager's multicall collecting a token's worth to the wallet and the rest elsewhere.
  [
    POSITIONS,
    [
      log(POSITIONS, "Approval(address,address,uint256)", [
        pad(OWNER),
        pad(zeroAddress),
        pad("0x1"),
      ]),
      transfer(TOKEN, POSITIONS, OWNER, 1n),
      transfer(TOKEN, POSITIONS, FAKE, 9n),
    ],
  ],
  // A claim.
  [DISTRIBUTOR, [transfer(TOKEN, DISTRIBUTOR, OWNER, 9n)]],
]);

// Enough of a chain to run a batch: USDC, and a router that pulls 5 of it for 9 PRL,
// handing 1 back as change.
async function simulateBlocks({ blocks: [block] }: { blocks: [{ calls: Calls }] }) {
  const allowances = new Map<string, bigint>();
  const calls = block.calls.map(({ to, data = "0x" }) => {
    const logs = apps.get(to);
    if (logs) return { status: "success", data: "0x", logs };
    if (to === ROUTER) {
      allowances.set(ROUTER, (allowances.get(ROUTER) ?? 0n) - 5_000_000n);
      return {
        status: "success",
        data: "0x",
        logs: [...swap, transfer(USDC, ROUTER, OWNER, 1_000_000n)],
      };
    }
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: data as Hex });
    if (functionName === "transfer") {
      const [recipient, amount] = args;
      return { status: "success", data: "0x", logs: [transfer(USDC, OWNER, recipient, amount)] };
    }
    if (functionName === "approve") {
      const [spender, amount] = args;
      allowances.set(spender, amount);
      return { status: "success", data: "0x", logs: [approval(spender, amount)] };
    }
    const [, spender] = args as readonly [Address, Address];
    return { status: "success", data: word(allowances.get(spender) ?? 0n), logs: [] };
  });
  return [{ calls }];
}

// Every app and token on it is a contract; a person's wallet has no code, or a 7702 delegation.
async function getCode({ address }: { address: Address }) {
  if (address === DELEGATED) return `0xef0100${ROUTER.slice(2)}`;
  return [FRIEND, DELEGATED].includes(address) ? undefined : "0x6080";
}

const approve = (spender: Address, amount: bigint) => ({
  to: USDC,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});
const send = (recipient: Address) => ({
  to: USDC,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, 5_000_000n],
  }),
});

describe("walletEffect", () => {
  it("keeps one leg for a token that logs both kinds of Transfer, as ERC-404 does", () => {
    const moved = walletEffect(
      [transfer(FAKE, OWNER, ROUTER, 10n ** 18n), nft(OWNER, ROUTER, 1n)],
      OWNER,
    );
    expect(moved.out).toEqual([{ token: FAKE, amount: 10n ** 18n + 1n }]);
    const approved = { amountUsd: "0", details: approvedEffect(moved) };
    expect(() => assertStillAsShown(approved, rawEffect(moved, names), moved)).not.toThrow();
  });
});

describe("simulateEffect", () => {
  const decided = async (calls: Calls) => ladder(await simulateEffect(8453, OWNER, calls));

  it("lets an approval the batch takes back go on a tap", async () => {
    expect(await decided([approve(FAKE, maxUint256), approve(FAKE, 0n)])).toBe("tap");
  });

  it("lets taking a permission back go on a tap", async () => {
    expect(await decided([approve(FAKE, 0n)])).toBe("tap");
  });

  it("asks for the owner's proof for a call that leaves no trace on the wallet", async () => {
    // Collateral an app holds leaves from the app, not the wallet, as Compound's withdrawTo does.
    expect(await decided([{ to: LENDER }])).toBe("proof: does something Auni can't see");
    // Taking a permission back in the same batch doesn't vouch for it.
    expect(await decided([approve(FAKE, 0n), { to: LENDER }])).toBe(
      "proof: does something Auni can't see",
    );
  });

  it("asks for the owner's proof for a call that brings a little in while sending the rest elsewhere", async () => {
    expect(await decided([{ to: POSITIONS }])).toBe("proof: does something Auni can't see");
  });

  it("lets a claim go on a tap", async () => {
    expect(await decided([{ to: DISTRIBUTOR }])).toBe("tap");
  });

  it("lets an exact approval the batch spends go on a tap", async () => {
    expect(await decided([approve(ROUTER, 5_000_000n), { to: ROUTER }])).toBe("tap");
  });

  it("counts an approval wider than what the batch spends", async () => {
    expect(await decided([approve(ROUTER, 10_000_000n), { to: ROUTER }])).toBe(
      "proof: lets 0x2222…2222 spend your USDC",
    );
  });

  it("names where what left the wallet went when an account keeps it", async () => {
    expect((await simulateEffect(8453, OWNER, [send(FRIEND)]))?.sentTo).toEqual([FRIEND]);
    expect(await decided([send(FRIEND)])).toBe(
      "proof: sends money to 0x7777…7777, where you've never sent before",
    );
    expect(ladder(await simulateEffect(8453, OWNER, [send(FRIEND)]), [FRIEND])).toBe("tap");
    // A wallet delegated under EIP-7702 runs code, but what it gets is still its owner's.
    expect((await simulateEffect(8453, OWNER, [send(DELEGATED)]))?.sentTo).toEqual([DELEGATED]);
  });

  // Live, 2026-11-14: a send to a token's own contract is lost, and its card must be able to say where.
  it("names a token's own contract sent that token, which keeps it for good", async () => {
    expect((await simulateEffect(8453, OWNER, [send(USDC)]))?.sentTo).toEqual([USDC]);
  });

  // A bridge's contract sends on to whoever its calldata names, so no code vouches for it.
  it("names no one when what left went to a contract, however often it was sent there", async () => {
    const batch = [approve(ROUTER, 5_000_000n), { to: ROUTER }];
    expect((await simulateEffect(8453, OWNER, batch))?.sentTo).toBeUndefined();
    const sent = await simulateEffect(8453, OWNER, [send(ROUTER)]);
    expect(ladder(sent, [ROUTER])).toBe("proof: sends money away, and Auni can't say where");
  });
});

describe("simulateEffect on a call that reverts", () => {
  it("throws core's sentence, keeping what the call reverted with for the app whose contract it is", async () => {
    const error = new ContractFunctionRevertedError({
      abi: [],
      data: "0xf722177f",
      functionName: "deposit",
    });
    rpcs.alchemy = {
      estimateFeesPerGas,
      simulateBlocks: async () => [{ calls: [{ status: "failure", data: "0x", logs: [], error }] }],
    };
    const thrown = await simulateEffect(8453, OWNER, [{ to: ROUTER }]).catch((caught) => caught);
    expect(thrown.message).toBe("Auni ran this first and it would have failed, so it wasn't sent.");
    expect(revertOf(thrown)).toBe("0xf722177f");
  });

  it("says one move failed however many calls it sends, keeping which for the agent", async () => {
    // A buy's approval and swap: the owner allowed one move, which the card names.
    const error = new ContractFunctionRevertedError({ abi: [], data: "0x", functionName: "swap" });
    rpcs.alchemy = {
      estimateFeesPerGas,
      simulateBlocks: async () => [
        {
          calls: [
            { status: "success", data: "0x", logs: [] },
            { status: "failure", data: "0x", logs: [], error },
          ],
        },
      ],
    };
    const thrown = await simulateEffect(8453, OWNER, [{ to: ROUTER }, { to: ROUTER }]).catch(
      (caught) => caught,
    );
    expect(thrown.message).toBe("Auni ran this first and it would have failed, so it wasn't sent.");
    expect(thrown).toMatchObject({ step: 2, of: 2 });
  });
});

// Bytes someone else built are signed only once a simulation has held them to their card.
describe("simulateEffect's RPCs", () => {
  const fails = () => Promise.reject(new Error("upstream unavailable"));
  const decided = async (calls: Calls) => ladder(await simulateEffect(8453, OWNER, calls));

  it("runs on the chain's public RPC when Alchemy can't", async () => {
    rpcs.alchemy = { estimateFeesPerGas, simulateBlocks: fails };
    rpcs.public = { estimateFeesPerGas, simulateBlocks };
    expect(await decided([{ to: DISTRIBUTOR }])).toBe("tap");
  });

  it("is null when no RPC can run it, so nothing unchecked is signed", async () => {
    rpcs.alchemy = { estimateFeesPerGas, simulateBlocks: fails };
    rpcs.public = { estimateFeesPerGas, simulateBlocks: fails };
    expect(await simulateEffect(8453, OWNER, [{ to: DISTRIBUTOR }])).toBeNull();
  });

  it("offers a real send's fees, so a contract can't tell it's simulated, unless the chain refuses them", async () => {
    const offered: unknown[] = [];
    rpcs.alchemy = {
      estimateFeesPerGas,
      simulateBlocks: (request: { blocks: [{ calls: Calls }] }) => {
        const [first] = request.blocks[0].calls as { maxFeePerGas?: bigint }[];
        offered.push(first?.maxFeePerGas);
        return first?.maxFeePerGas ? fails() : simulateBlocks(request);
      },
    };
    expect(await decided([{ to: DISTRIBUTOR }])).toBe("tap");
    expect(offered).toEqual([30n, undefined]);
  });
});

// Money landing with a contract that then runs calls (Across's handler on the chain a bridge lands
// on) is simulated as it would arrive: the token's own slot for that balance set to it, and the
// calls sent by someone other than the owner, as a relayer sends them.
describe("simulateEffect with money arriving", () => {
  const HANDLER: Address = "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E";
  const FILLER: Address = "0x5555555555555555555555555555555555555555";
  // A proxy's implementation slot, which its balanceOf reads too and which set breaks it, then
  // the slot of the handler's balance.
  const IMPLEMENTATION = pad("0x01");
  const BALANCE = pad("0x02");
  type Block = {
    calls: { account: Address; to: Address; data?: Hex }[];
    stateOverrides?: {
      address: Address;
      balance?: bigint;
      stateDiff?: { slot: Hex; value: Hex }[];
    }[];
  };
  const ran: Block[] = [];
  const asked: Record<string, unknown>[] = [];
  /** USDC whose balanceOf reads `slots`, holding at `balanceAt` what's set there. */
  const chain = (slots: Hex[], balanceAt: Hex | null) => ({
    estimateFeesPerGas,
    getCode,
    createAccessList: async (request: Record<string, unknown>) => {
      asked.push(request);
      return {
        accessList: [{ address: USDC.toLowerCase(), storageKeys: slots }],
        gasUsed: 0n,
      };
    },
    simulateBlocks: async ({ blocks: [block] }: { blocks: [Block] }) => {
      ran.push(block);
      const [set] = block.stateOverrides?.find(({ address }) => address === USDC)?.stateDiff ?? [];
      const held = set?.slot === balanceAt ? BigInt(set.value) : 0n;
      const calls = block.calls.map(({ to }) =>
        to === USDC
          ? { status: "success", data: set?.slot === IMPLEMENTATION ? "0x" : word(held), logs: [] }
          : { status: "success", data: "0x", logs: [transfer(TOKEN, HANDLER, OWNER, held)] },
      );
      return [{ calls }];
    },
  });
  const arriving = { token: USDC, holder: HANDLER, amount: 1_833_913n };

  beforeEach(() => {
    ran.length = 0;
    asked.length = 0;
  });

  // Arbitrum's and Polygon's nodes refuse a read at a fee of zero, and Arbitrum's and BNB Chain's
  // one from an account with no coin: asked either way, a bridge landing there couldn't be checked.
  it("asks which slots the balance is read from as the zero address, naming no fee", async () => {
    rpcs.alchemy = chain([BALANCE], BALANCE);
    await simulateEffect(8453, OWNER, [{ to: HANDLER }], { arriving, from: FILLER });
    expect(asked).toEqual([
      {
        account: "0x0000000000000000000000000000000000000000",
        to: USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [HANDLER] }),
      },
    ]);
  });

  it("runs the calls from who sends them, with what arrived already where it lands", async () => {
    rpcs.alchemy = chain([IMPLEMENTATION, BALANCE], BALANCE);
    const simulated = await simulateEffect(8453, OWNER, [{ to: HANDLER }], {
      arriving,
      from: FILLER,
    });
    // What it does to the owner's wallet, though the owner sent nothing.
    expect(simulated?.in).toEqual([{ token: TOKEN, amount: 1_833_913n }]);
    expect(new Set(ran.flatMap((block) => block.calls.map((call) => call.account)))).toEqual(
      new Set([FILLER]),
    );
    const fill = ran.at(-1)!;
    expect(fill.calls).toMatchObject([{ to: HANDLER }]);
    // Coin for its gas, which an account nobody holds has none of.
    expect(fill.stateOverrides).toEqual([
      { address: FILLER, balance: 10n ** 30n },
      { address: USDC, stateDiff: [{ slot: BALANCE, value: pad("0x1bfbb9") }] },
    ]);
  });

  it("is null for a token none of whose slots reads back as its balance, so nothing is guessed", async () => {
    rpcs.alchemy = chain([IMPLEMENTATION], BALANCE);
    expect(
      await simulateEffect(8453, OWNER, [{ to: HANDLER }], { arriving, from: FILLER }),
    ).toBeNull();
  });
});
