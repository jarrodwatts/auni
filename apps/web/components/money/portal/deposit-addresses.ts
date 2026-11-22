import { getAddress, isAddress, zeroAddress } from "viem";

import { depositNetworks, type DepositNetwork } from "@/lib/data/portfolio";

/** One address and every network it receives on. */
export interface DepositAddress {
  /** Exactly what is copied and scanned; an EVM address in its checksummed form. */
  readonly address: string;
  readonly networks: readonly DepositNetwork[];
}

/** Every network money can come in on, at stand-in addresses, while the account's wallets get ready. */
export const PLACEHOLDERS = depositNetworks({ evm: zeroAddress, solana: "solana" });

/**
 * The networks folded by the address that receives on them, in the order they came: every EVM
 * network shares one address, so a person never has to pick one before sending.
 */
export function depositAddresses(networks: readonly DepositNetwork[]): readonly DepositAddress[] {
  const folded = new Map<string, DepositNetwork[]>();
  for (const network of networks) {
    // An EVM address folds whatever its case; any other kind, such as Solana's, is kept as given.
    const address = isAddress(network.address) ? getAddress(network.address) : network.address;
    folded.set(address, [...(folded.get(address) ?? []), network]);
  }
  return [...folded].map(([address, entries]) => ({ address, networks: entries }));
}

/** An address's networks in brief, under it in its row: "Solana", "Monad and Base", "Monad, Base and 7 more". */
export function networksInBrief(networks: readonly DepositNetwork[]): string {
  if (networks.length <= 2) return networkNames(networks);
  const [first, second] = networks;
  return `${first!.networkName}, ${second!.networkName} and ${networks.length - 2} more`;
}

/** "Monad", "Monad and Base", "Monad, Base and Solana"; or "Monad, Base or Solana". */
export function networkNames(
  networks: readonly DepositNetwork[],
  joiner: "and" | "or" = "and",
): string {
  const names = networks.map(({ networkName }) => networkName);
  const last = names.pop();
  return names.length > 0 ? `${names.join(", ")} ${joiner} ${last}` : (last ?? "");
}

/** The network money landed on, from the name it's told by ("Base"); null for one not offered. */
export function networkNamed(
  networks: readonly DepositNetwork[],
  name: string,
): DepositNetwork["key"] | null {
  return networks.find(({ networkName }) => networkName === name)?.key ?? null;
}

/** The ends people check an address by: "0x5aAe…eAed", "9WzD…AWWM". */
export function shortAddress(address: string): string {
  const head = address.startsWith("0x") ? 6 : 4;
  return `${address.slice(0, head)}…${address.slice(-4)}`;
}

/**
 * The tokens a deposit card waits for by contract, each beside the ends of its address:
 * "STANDARD at 0x88ad…9062". Only a token at that address counts as theirs when it lands, so
 * the card shows which one. A token named without an address is in the title alone.
 */
export function watchedTokens(
  tokens: readonly { readonly name: string; readonly address: string | null }[],
): readonly string[] {
  return tokens.flatMap(({ name, address }) =>
    address ? [`${name} at ${shortAddress(address)}`] : [],
  );
}
