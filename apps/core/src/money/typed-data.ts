import { isAddressEqual, recoverTypedDataAddress, type Hex } from "viem";

import type { Signer } from "./recipe.ts";

export type Fields = readonly { readonly name: string; readonly type: string }[];

export interface TypedData {
  readonly domain: Readonly<Record<string, unknown>>;
  readonly types: Readonly<Record<string, Fields>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}

const DOMAIN_FIELDS: Fields = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];

// Wallet policy rules compare lowercase addresses, and bigints do not survive JSON.
export function walletDocument(typedData: TypedData): TypedData {
  const domainFields = DOMAIN_FIELDS.filter((field) => typedData.domain[field.name] !== undefined);
  const types = { EIP712Domain: domainFields, ...typedData.types };
  return {
    domain: jsonStruct(types, "EIP712Domain", typedData.domain),
    types,
    primaryType: typedData.primaryType,
    message: jsonStruct(types, typedData.primaryType, typedData.message),
  };
}

function jsonStruct(
  types: Readonly<Record<string, Fields>>,
  name: string,
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const fields = types[name];
  if (!fields) throw new Error(`Typed data declares no ${name} struct`);
  return Object.fromEntries(
    fields.map((field) => [field.name, jsonValue(types, field.type, value[field.name])]),
  );
}

function jsonValue(types: Readonly<Record<string, Fields>>, type: string, value: unknown): unknown {
  if (type.endsWith("[]"))
    return (value as readonly unknown[]).map((entry) => jsonValue(types, type.slice(0, -2), entry));
  if (types[type]) return jsonStruct(types, type, value as Record<string, unknown>);
  if (type === "address") return (value as string).toLowerCase();
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * Signs as the owner's wallet and checks it really was theirs before anything
 * goes out: a venue answers a stranger's signature vaguely (one perps venue says
 * "User or API Wallet does not exist").
 */
export async function signTyped(wallets: Signer, typedData: TypedData): Promise<Hex> {
  const signature = (await wallets.signEvmTypedData(walletDocument(typedData))) as Hex;
  const signer = await recoverTypedDataAddress({ ...typedData, signature } as Parameters<
    typeof recoverTypedDataAddress
  >[0]);
  if (!isAddressEqual(signer, wallets.evmAddress as Hex)) {
    throw new Error(
      "The wallet signature did not recover to the owner's address, so nothing was sent.",
    );
  }
  return signature;
}
