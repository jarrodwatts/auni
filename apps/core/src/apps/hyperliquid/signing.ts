import { encode } from "@msgpack/msgpack";
import { concatBytes, keccak256, numberToBytes, parseSignature, zeroAddress, type Hex } from "viem";

import type { Signer } from "../../money/recipe.ts";
import { signTyped, type Fields, type TypedData } from "../../money/typed-data.ts";

export interface HyperliquidSignature {
  readonly r: Hex;
  readonly s: Hex;
  readonly v: number;
}

// User-signed actions declare chain 0x66eee on every network; it is not where funds settle.
export const SIGNATURE_CHAIN_ID_HEX = "0x66eee";

// msgpack(action) ++ nonce ++ 0x00 (no vault); key order is hashed, so actions are built as literals.
export function actionHash(action: unknown, nonce: number): Hex {
  return keccak256(
    concatBytes([encode(action), numberToBytes(BigInt(nonce), { size: 8 }), Uint8Array.of(0)]),
  );
}

export function l1TypedData(action: unknown, nonce: number): TypedData {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zeroAddress },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: "a", connectionId: actionHash(action, nonce) },
  };
}

export function userSignedTypedData(
  primaryType: string,
  fields: Fields,
  action: Record<string, unknown>,
): TypedData {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421_614,
      verifyingContract: zeroAddress,
    },
    types: { [primaryType]: fields },
    primaryType,
    message: Object.fromEntries(fields.map((field) => [field.name, action[field.name]])),
  };
}

export const WITHDRAW_FIELDS = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "amount", type: "string" },
  { name: "time", type: "uint64" },
];

export const USER_SET_ABSTRACTION_FIELDS = [
  { name: "hyperliquidChain", type: "string" },
  { name: "user", type: "address" },
  { name: "abstraction", type: "string" },
  { name: "nonce", type: "uint64" },
];

export async function signTypedData(
  wallets: Signer,
  typedData: TypedData,
): Promise<HyperliquidSignature> {
  const { r, s, yParity } = parseSignature(await signTyped(wallets, typedData));
  return { r, s, v: 27 + (yParity ?? 0) };
}
