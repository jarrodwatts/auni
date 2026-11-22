import { concatHex, encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";

import type { EvmSend, EvmTx } from "./recipe.ts";

// How a wallet with a plain key sends a list of calls as one transaction, all or nothing. EIP-7702
// lets the key's address run account code (the address is delegated to it), and ERC-7579 is how
// such code is handed a list: `execute`, called by the account on itself. Each wallet app picks
// the account code it trusts; this file is only the two standards' shapes.

/** The code of an address delegated to `code`: EIP-7702's prefix, then the code's address. */
export function delegatedTo(code: Address): Hex {
  return concatHex(["0xef0100", code]).toLowerCase() as Hex;
}

/** The account code an address is delegated to, by what the chain says its code is; null when none. */
export function delegateOf(code: Hex | undefined): Address | null {
  return code && /^0xef0100[0-9a-f]{40}$/iu.test(code) ? (`0x${code.slice(8)}` as Address) : null;
}

/** ERC-7579's mode for a batch (call type 0x01) that reverts whole if any call does. */
const BATCH_MODE: Hex = `0x01${"00".repeat(31)}`;

const EXECUTE = [
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
] as const;

const EXECUTIONS = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;

/** One call as a transaction of its own, sent as it was built. */
export function plainCall(tx: EvmTx): EvmSend {
  return {
    to: tx.to as Address,
    ...(tx.data ? { data: tx.data as Hex } : {}),
    value: BigInt(tx.value ?? "0"),
  };
}

/**
 * A list as one call from the account to itself, which its ERC-7579 account code runs call by
 * call. Coin a call sends leaves the account as that call runs, so the one call carries none.
 */
export function batchCall(owner: Address, txs: readonly EvmTx[]): EvmSend {
  const executions = txs.map((tx) => ({
    target: tx.to as Address,
    value: BigInt(tx.value ?? "0"),
    callData: (tx.data ?? "0x") as Hex,
  }));
  return {
    to: owner,
    data: encodeFunctionData({
      abi: EXECUTE,
      functionName: "execute",
      args: [BATCH_MODE, encodeAbiParameters(EXECUTIONS, [executions])],
    }),
    value: 0n,
  };
}
