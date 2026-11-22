import { createWalletClient, custom, type Address, type EIP1193Provider } from "viem";

/**
 * Read-only access to an injected EIP-1193 browser wallet (MetaMask, Rabby, Coinbase Wallet, etc.)
 * solely to read a public address for watch-only personalization. Never signs or sends anything.
 */
export function browserWallet(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

/** Asks the browser wallet to share its public address for watch-only tracking. */
export async function connect(provider: EIP1193Provider): Promise<Address> {
  const [account] = await createWalletClient({ transport: custom(provider) }).requestAddresses();
  if (!account) throw new Error("The wallet shared no account.");
  return account;
}
