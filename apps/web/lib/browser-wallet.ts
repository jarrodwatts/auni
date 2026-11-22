import type { FundingQuoteWire } from "@auni/shared";
import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";

// A wallet in the browser (MetaMask, Rabby, Coinbase Wallet and the like) that pays into Auni:
// it signs and sends each step of a quote core checked, asking its owner before each one. Auni
// never holds or sees anything of it but its address.

/** The browser's wallet, when one is installed. */
export function browserWallet(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

/** Asks the wallet for its account, which it shows its owner first. */
export async function connect(provider: EIP1193Provider): Promise<Address> {
  const [account] = await createWalletClient({ transport: custom(provider) }).requestAddresses();
  if (!account) throw new Error("The wallet shared no account.");
  return account;
}

/** Moves the wallet onto `chain`, adding the chain first where the wallet doesn't know it. */
export async function switchTo(provider: EIP1193Provider, chain: Chain): Promise<void> {
  const wallet = createWalletClient({ transport: custom(provider) });
  if ((await wallet.getChainId()) === chain.id) return;
  try {
    await wallet.switchChain({ id: chain.id });
  } catch (error) {
    // 4902: the wallet hasn't heard of the chain.
    if ((error as { code?: number }).code !== 4902) throw error;
    await wallet.addChain({ chain });
  }
}

export type Step = FundingQuoteWire["steps"][number];

/**
 * Sends each step in order, each only once the one before has landed, as the deposit spends the
 * approval before it. A step the wallet's owner turns down, or one that fails, stops the rest.
 */
export async function runSteps(
  steps: readonly Step[],
  wallet: {
    readonly send: (step: Step) => Promise<Hex>;
    readonly landed: (hash: Hex) => Promise<boolean>;
  },
  onStep: (index: number) => void,
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    onStep(index);
    const hash = await wallet.send(step);
    if (!(await wallet.landed(hash)))
      throw new Error(`The ${step.id} didn't go through, so nothing more was sent.`);
  }
}

/** The steps' sender and lander, through the browser's wallet, from `account`. */
export function walletSender(provider: EIP1193Provider, account: Address) {
  const wallet = createWalletClient({ account, transport: custom(provider) });
  const chain = createPublicClient({ transport: custom(provider) });
  return {
    send: (step: Step) =>
      wallet.sendTransaction({ chain: null, to: step.to as Address, data: step.data as Hex }),
    landed: async (hash: Hex) =>
      (await chain.waitForTransactionReceipt({ hash })).status === "success",
  };
}
