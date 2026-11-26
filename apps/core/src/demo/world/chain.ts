import { NETWORKS, EVM_CHAIN_KEYS, type EvmChainKey } from "@auni/shared";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  keccak256,
  multicall3Abi,
  numberToHex,
  pad,
  parseAbi,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";

import { rpcHost } from "../home.ts";
import type { Asked, Service } from "../world.ts";

// The demo's EVM chains: one small ledger that every chain's RPC stand-in reads and writes. It
// keeps what each address holds of each token, runs the few contracts the demo's moves call
// (ERC-20 tokens, the batched read every viem client makes, and whatever a stand-in service
// adds with `deploy`), and answers the JSON-RPC methods core asks a node. A transaction is
// "mined" the moment the demo wallet hands it over (see `send`), so a move plays through at once.

/** A log as a node reports it, before it is given its place in a block. */
export interface Emitted {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

/** One call a contract is asked to run. */
export interface Call {
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** What a call did: what it returned, and the logs it emitted. */
interface Ran {
  readonly returned: Hex;
  readonly logs: readonly Emitted[];
}

/** A contract the demo runs: its answer to a call, or a throw (a `Reverted`) when it refuses. */
export type Contract = (call: Call, chain: Chain) => Ran;

/** A call the chain refused, with the reason a node would give. */
export class Reverted extends Error {}

/** A revert's reason as a node returns it: Solidity's `Error(string)`. */
const revertData = (reason: string): Hex =>
  encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "reason", type: "string" }] }],
    errorName: "Error",
    args: [reason],
  });

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const APPROVAL = toEventSelector("Approval(address,address,uint256)");
const uint = (value: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [value]);

/** A Transfer log, as an ERC-20 emits it. */
export function transferLog(token: Address, from: Address, to: Address, units: bigint): Emitted {
  return { address: token, topics: [TRANSFER, pad(from), pad(to)], data: uint(units) };
}

interface Token {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

interface Mined {
  readonly hash: Hex;
  readonly from: Address;
  readonly to: Address;
  readonly block: number;
  readonly logs: readonly Emitted[];
}

const key = (...parts: readonly string[]) => parts.join(":").toLowerCase();

/** One EVM chain as the demo keeps it. */
export class Chain {
  readonly id: number;
  readonly name: EvmChainKey;
  /** Balances by `token:holder`, the chain's own coin under the token "native". */
  private balances = new Map<string, bigint>();
  /** Allowances by `token:owner:spender`. */
  private allowances = new Map<string, bigint>();
  private readonly tokens = new Map<string, Token>();
  private readonly contracts = new Map<string, Contract>();
  private readonly mined = new Map<string, Mined>();
  private readonly watchers: ((tx: Mined) => void)[] = [];
  private nonce = 0;

  constructor(name: EvmChainKey) {
    this.name = name;
    this.id = NETWORKS[name].viem.id;
  }

  /** Lists an ERC-20 token at `address`, so the chain answers for it as its contract. */
  list(address: string, token: Token): void {
    this.tokens.set(address.toLowerCase(), token);
  }

  /** Puts a contract of a stand-in service's own at `address`. */
  deploy(address: string, contract: Contract): void {
    this.contracts.set(address.toLowerCase(), contract);
  }

  /** Tells `watcher` of every transaction as it is mined: how a venue sees a deposit sent to it. */
  watch(watcher: (tx: Mined) => void): void {
    this.watchers.push(watcher);
  }

  held(token: string, holder: string): bigint {
    return this.balances.get(key(token, holder)) ?? 0n;
  }

  /** Changes what `holder` has of `token` by `units`; a contract refuses a spend past the balance. */
  credit(token: string, holder: string, units: bigint): void {
    const next = this.held(token, holder) + units;
    if (next < 0n) throw new Reverted("ERC20: transfer amount exceeds balance");
    this.balances.set(key(token, holder), next);
  }

  /** Moves `units` of `token`, as its contract would, and says so in a Transfer log. */
  move(token: Address, from: Address, to: Address, units: bigint): Emitted {
    this.credit(token, from, -units);
    this.credit(token, to, units);
    return transferLog(token, from, to, units);
  }

  /** Takes `units` of `owner`'s allowance to `spender`, refusing when it was never given. */
  spend(token: Address, owner: Address, spender: Address, units: bigint): void {
    const allowed = this.allowances.get(key(token, owner, spender)) ?? 0n;
    if (allowed < units) throw new Reverted("ERC20: insufficient allowance");
    this.allowances.set(key(token, owner, spender), allowed - units);
  }

  /** Runs one call: a plain payment, a token's own contract, or one a service deployed. */
  private run(call: Call, traced = false): Ran {
    const logs: Emitted[] = [];
    if (call.value > 0n) {
      this.credit("native", call.from, -call.value);
      this.credit("native", call.to, call.value);
      // A node asked to trace transfers says the chain's coin moved as a token's Transfer would.
      if (traced) logs.push(transferLog(NATIVE, call.from, call.to, call.value));
    }
    const contract = this.contracts.get(call.to.toLowerCase());
    if (contract) {
      const ran = contract(call, this);
      return { returned: ran.returned, logs: [...logs, ...ran.logs] };
    }
    if (this.tokens.has(call.to.toLowerCase())) return this.erc20(call);
    if (call.data === "0x") return { returned: "0x", logs };
    throw new Reverted(`The demo chain runs no contract at ${call.to}.`);
  }

  private erc20(call: Call): Ran {
    const token = this.tokens.get(call.to.toLowerCase())!;
    const { functionName, args } = decodeFunctionData({ abi: TOKEN_ABI, data: call.data });
    const answer = (result: unknown): Ran => ({
      returned: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result } as never),
      logs: [],
    });
    switch (functionName) {
      case "symbol":
        return answer(token.symbol);
      case "name":
        return answer(token.name);
      case "decimals":
        return answer(token.decimals);
      case "totalSupply":
        return answer(10n ** 27n);
      // An xStock's shares are its balance here: the demo's stocks have a multiplier of one.
      case "balanceOf":
      case "sharesOf":
        return answer(this.held(call.to, args[0]));
      case "multiplier":
        return answer(10n ** 18n);
      case "allowance":
        return answer(this.allowances.get(key(call.to, args[0], args[1])) ?? 0n);
      case "approve": {
        const [spender, units] = args;
        this.allowances.set(key(call.to, call.from, spender), units);
        return {
          returned: encodeFunctionResult({ abi: erc20Abi, functionName, result: true }),
          logs: [
            {
              address: call.to,
              topics: [APPROVAL, pad(call.from), pad(spender)],
              data: uint(units),
            },
          ],
        };
      }
      case "transfer": {
        const [to, units] = args;
        return {
          returned: encodeFunctionResult({ abi: erc20Abi, functionName, result: true }),
          logs: [this.move(call.to, call.from, to, units)],
        };
      }
      case "transferFrom": {
        const [from, to, units] = args;
        this.spend(call.to, from, call.from, units);
        return {
          returned: encodeFunctionResult({ abi: erc20Abi, functionName, result: true }),
          logs: [this.move(call.to, from, to, units)],
        };
      }
    }
  }

  /**
   * Runs `calls` in order and puts the chain back as it was: what they would do, and no more.
   * `traced` also reports each move of the chain's own coin, which leaves no log when mined.
   */
  simulate(calls: readonly Call[], traced = false): (Ran | Reverted)[] {
    const [balances, allowances] = [new Map(this.balances), new Map(this.allowances)];
    try {
      const results: (Ran | Reverted)[] = [];
      for (const call of calls) {
        try {
          results.push(this.run(call, traced));
        } catch (error) {
          results.push(error instanceof Reverted ? error : new Reverted(String(error)));
          break;
        }
      }
      return results;
    } finally {
      [this.balances, this.allowances] = [balances, allowances];
    }
  }

  /**
   * Mines `calls` as one transaction from `from`, all or nothing, and returns its hash: how the
   * demo wallet sends (demo/wallet.ts). A call that reverts leaves the chain as it was and throws.
   */
  send(from: Address, calls: readonly Omit<Call, "from">[]): Hex {
    const [balances, allowances] = [new Map(this.balances), new Map(this.allowances)];
    try {
      const logs = calls.flatMap((call) => this.run({ ...call, from }).logs);
      this.nonce += 1;
      const hash = keccak256(toHex(`${this.name}:${this.nonce}`));
      const tx = { hash, from, to: calls.at(-1)!.to, block: blockNow(), logs };
      this.mined.set(hash, tx);
      for (const watcher of this.watchers) watcher(tx);
      return hash;
    } catch (error) {
      [this.balances, this.allowances] = [balances, allowances];
      throw error;
    }
  }

  /** The chain's answer to one JSON-RPC call, as a node gives it. */
  rpc(method: string, params: readonly unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return numberToHex(this.id);
      case "net_version":
        return String(this.id);
      case "eth_blockNumber":
        return numberToHex(blockNow());
      case "eth_getBalance":
        return numberToHex(this.held("native", params[0] as string));
      case "eth_getTransactionCount":
        return numberToHex(this.nonce);
      case "eth_getCode": {
        const address = (params[0] as string).toLowerCase();
        // Anything the chain runs has code; every other address is someone's account.
        return this.tokens.has(address) || this.contracts.has(address) ? "0x60" : "0x";
      }
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return numberToHex(1_000_000_000n);
      case "eth_estimateGas":
        return numberToHex(120_000n);
      case "eth_getLogs": {
        const [{ fromBlock, toBlock, address, topics = [] }] = params as [
          {
            fromBlock: Hex;
            toBlock: Hex;
            address?: string;
            topics?: readonly (Hex | null)[];
          },
        ];
        return [...this.mined.values()]
          .filter((tx) => tx.block >= Number(fromBlock) && tx.block <= Number(toBlock))
          .flatMap((tx) =>
            tx.logs.flatMap((log, index) =>
              (!address || log.address.toLowerCase() === address.toLowerCase()) &&
              topics.every(
                (topic, at) =>
                  topic === null || log.topics[at]?.toLowerCase() === topic.toLowerCase(),
              )
                ? [rpcLog(log, index, tx.block, tx.hash)]
                : [],
            ),
          );
      }
      case "eth_getBlockByNumber":
        return block(params[0] === "latest" ? blockNow() : Number(params[0]));
      case "eth_call": {
        const [{ from, to, data, value }] = params as [RpcCall];
        const [ran] = this.simulate([
          { from: from ?? ZERO, to, data: data ?? "0x", value: BigInt(value ?? 0) },
        ]);
        if (ran instanceof Reverted) throw new RpcRefusal(3, `execution reverted: ${ran.message}`);
        return ran!.returned;
      }
      case "eth_simulateV1": {
        const [{ blockStateCalls, traceTransfers }] = params as [
          { blockStateCalls: { calls: readonly RpcCall[] }[]; traceTransfers?: boolean },
        ];
        return blockStateCalls.map(({ calls }) => {
          const results = this.simulate(
            calls.map(({ from, to, data, value }) => ({
              from: from ?? ZERO,
              to,
              data: data ?? "0x",
              value: BigInt(value ?? 0),
            })),
            traceTransfers,
          );
          return {
            ...block(blockNow()),
            calls: results.map((ran) =>
              ran instanceof Reverted
                ? {
                    status: "0x0",
                    // As a node says it: the reason, encoded as Solidity's Error(string).
                    returnData: revertData(ran.message),
                    gasUsed: "0x0",
                    logs: [],
                    error: { code: 3, message: `execution reverted: ${ran.message}` },
                  }
                : {
                    status: "0x1",
                    returnData: ran.returned,
                    gasUsed: numberToHex(60_000n),
                    logs: ran.logs.map((log, index) => rpcLog(log, index, blockNow(), ZERO_HASH)),
                  },
            ),
          };
        });
      }
      case "eth_getTransactionReceipt": {
        const tx = this.mined.get(params[0] as string);
        if (!tx) return null;
        return {
          transactionHash: tx.hash,
          transactionIndex: "0x0",
          blockHash: blockHash(tx.block),
          blockNumber: numberToHex(tx.block),
          from: tx.from,
          to: tx.to,
          cumulativeGasUsed: numberToHex(120_000n),
          gasUsed: numberToHex(120_000n),
          effectiveGasPrice: numberToHex(1_000_000_000n),
          contractAddress: null,
          logs: tx.logs.map((log, index) => rpcLog(log, index, tx.block, tx.hash)),
          logsBloom: `0x${"0".repeat(512)}`,
          status: "0x1",
          type: "0x2",
        };
      }
      case "eth_getTransactionByHash": {
        const tx = this.mined.get(params[0] as string);
        if (!tx) return null;
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          blockHash: blockHash(tx.block),
          blockNumber: numberToHex(tx.block),
          transactionIndex: "0x0",
          nonce: "0x0",
          value: "0x0",
          gas: numberToHex(120_000n),
          gasPrice: numberToHex(1_000_000_000n),
          input: "0x",
          type: "0x2",
          chainId: numberToHex(this.id),
          v: "0x0",
          r: ZERO_HASH,
          s: ZERO_HASH,
        };
      }
      default:
        throw new RpcRefusal(-32601, `The demo chain doesn't answer ${method}.`);
    }
  }
}

interface RpcCall {
  readonly from?: Address;
  readonly to: Address;
  readonly data?: Hex;
  readonly value?: Hex;
}

/** An error a node answers with, by its JSON-RPC code. */
class RpcRefusal extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** The address a node's traced transfers of the chain's own coin are logged from (ERC-7528). */
export const NATIVE: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
// An xStock also says its shares and the multiplier between them and its balance.
const TOKEN_ABI = [
  ...erc20Abi,
  ...parseAbi([
    "function sharesOf(address) view returns (uint256)",
    "function multiplier() view returns (uint256)",
  ]),
];

/** A block a second, counted from the clock, so a later read is always a later block. */
const blockNow = () => Math.floor(Date.now() / 1_000);
const blockHash = (number: number): Hex => keccak256(toHex(`block:${number}`));

function block(number: number) {
  return {
    number: numberToHex(number),
    hash: blockHash(number),
    parentHash: blockHash(number - 1),
    timestamp: numberToHex(number),
    gasLimit: numberToHex(30_000_000n),
    gasUsed: "0x0",
    baseFeePerGas: numberToHex(1_000_000_000n),
    miner: ZERO,
    transactions: [],
    logsBloom: `0x${"0".repeat(512)}`,
    extraData: "0x",
    nonce: "0x0000000000000000",
    size: "0x0",
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    transactionsRoot: ZERO_HASH,
    sha3Uncles: ZERO_HASH,
    mixHash: ZERO_HASH,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    uncles: [],
  };
}

function rpcLog(log: Emitted, index: number, blockNumber: number, hash: Hex) {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: numberToHex(blockNumber),
    blockHash: blockHash(blockNumber),
    blockTimestamp: numberToHex(blockNumber),
    transactionHash: hash,
    transactionIndex: "0x0",
    logIndex: numberToHex(index),
    removed: false,
  };
}

/** The batched reads viem makes of a chain (Multicall3): each call's answer, and a coin balance. */
const multicall: Contract = (call, chain) => {
  const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: call.data });
  if (functionName === "getEthBalance") {
    const result = chain.held("native", args[0]);
    return {
      returned: encodeFunctionResult({ abi: multicall3Abi, functionName, result }),
      logs: [],
    };
  }
  if (functionName !== "aggregate3")
    throw new Reverted(`The demo's Multicall3 doesn't run ${functionName}.`);
  const result = args[0].map(({ target, callData }) => {
    const [ran] = chain.simulate([{ from: call.from, to: target, data: callData, value: 0n }]);
    return ran instanceof Reverted
      ? { success: false, returnData: "0x" as Hex }
      : { success: true, returnData: ran!.returned };
  });
  return {
    returned: encodeFunctionResult({ abi: multicall3Abi, functionName, result }),
    logs: [],
  };
};

/** Every chain Auni names, each with its USDC listed and the batched read in place. */
export const chains: ReadonlyMap<EvmChainKey, Chain> = new Map(
  EVM_CHAIN_KEYS.map((name) => {
    const chain = new Chain(name);
    const { usdc, viem } = NETWORKS[name];
    if (usdc) chain.list(usdc, { symbol: "USDC", name: "USD Coin", decimals: 6 });
    const batched = viem.contracts?.multicall3?.address;
    if (batched) chain.deploy(batched, multicall);
    return [name, chain];
  }),
);

/** The address a made-up contract or account lives at, the same on every run. */
export function addressOf(name: string): Address {
  return getAddress(`0x${keccak256(toHex(`auni demo: ${name}`)).slice(-40)}`);
}

/** Every EVM chain's node: one JSON-RPC call, or a batch of them. */
export const evmRpc: Service = {
  hosts: [...chains.keys()].map(rpcHost),
  answer({ url, body }: Asked) {
    const chain = [...chains.values()].find(({ name }) => rpcHost(name) === url.hostname)!;
    const one = ({ id, method, params }: { id: unknown; method: string; params?: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id, result: chain.rpc(method, params ?? []) };
      } catch (error) {
        const code = error instanceof RpcRefusal ? error.code : -32603;
        return { jsonrpc: "2.0", id, error: { code, message: (error as Error).message } };
      }
    };
    return Array.isArray(body) ? body.map(one) : one(body as Parameters<typeof one>[0]);
  },
};
