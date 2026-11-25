import { EVM_CHAIN_KEYS, NETWORKS, splitKeys, type PrivateFieldWire } from "@auni/shared";
import { isHex, type Address } from "viem";

import { evmClient } from "../../money/chains.ts";
import { PrivateFieldRefused, type PrivateValues } from "../../private-fields.ts";
import type { WalletAddresses, WalletKeys } from "../contract.ts";
import { DELEGATED } from "./evm.ts";
import { addressesOf } from "./keys.ts";

// Keys the owner already holds, such as the ones auni.io's take-home page gives from Privy: the
// same addresses, so the same money and positions. Pasted into a private field, never a terminal
// the agent could read. Either key may be left out.

const SOLANA_INPUT = {
  name: "solana",
  label: "Solana private key",
  placeholder: "About 88 letters and numbers",
  set: false,
};

/**
 * The private field's inputs: what Get my keys gave, one key or both (splitKeys), and a Solana key
 * on its own, which the web app asks for only when what was pasted has none.
 */
export const BRING_INPUTS: PrivateFieldWire["inputs"] = [
  { name: "keys", label: "Your keys", placeholder: "Paste what Get my keys gave you", set: false },
  SOLANA_INPUT,
];

/** The input a Solana key brought beside the wallet's EVM key is typed into. */
export const SOLANA_INPUTS: PrivateFieldWire["inputs"] = [SOLANA_INPUT];

/** Where keys the owner brings go, as the line under their field says it. */
export const GOES_TO_WALLET = "Saved to your wallet, only on this computer. Your AI never sees it.";

/**
 * The keys pasted, in whichever of the field's inputs, checked: refused with a fixed message,
 * never one that quotes them.
 */
export async function broughtKeys(
  values: PrivateValues,
): Promise<{ readonly keys: WalletKeys; readonly addresses: WalletAddresses }> {
  const pasted = splitKeys(Object.values(values).join("\n"));
  if (pasted.evm.length > 1 || pasted.solana.length > 1)
    throw new PrivateFieldRefused("That's more than one key of a kind. Paste one of each at most.");
  const evmTyped = pasted.evm[0] ?? "";
  const solanaTyped = pasted.solana[0] ?? "";
  if (!evmTyped && !solanaTyped) throw new PrivateFieldRefused("Paste at least one key.");
  const evm = evmTyped ? (evmTyped.startsWith("0x") ? evmTyped : `0x${evmTyped}`) : null;
  if (evm && !(isHex(evm) && evm.length === 66))
    throw new PrivateFieldRefused(
      "That doesn't look like the whole key. Copy all of it and paste again.",
    );
  const keys: WalletKeys = { evm: evm?.toLowerCase() ?? null, solana: solanaTyped || null };
  // Each key on its own, so a refusal names the one at fault.
  const [{ evm: evmAddress }, { solana: solanaAddress }] = await Promise.all([
    addressesOf({ evm: keys.evm, solana: null }).catch(() => {
      throw new PrivateFieldRefused(
        "That isn't a key any wallet could use. Copy it again from auni.io.",
      );
    }),
    addressesOf({ evm: null, solana: keys.solana }).catch(() => {
      throw new PrivateFieldRefused(
        "That doesn't look like the whole Solana key. Copy all of it and paste again.",
      );
    }),
  ]);
  return { keys, addresses: { evm: evmAddress, solana: solanaAddress } };
}

/** A Solana key brought beside the wallet's EVM key: that alone, or refused. */
export async function solanaAlone(values: PrivateValues): ReturnType<typeof broughtKeys> {
  const brought = await broughtKeys({ solana: values.solana ?? "" });
  if (!brought.keys.solana || brought.keys.evm)
    throw new PrivateFieldRefused("That isn't a Solana key.");
  return brought;
}

/** The addresses keys sign for, on one line, as the owner checks them before bringing them in. */
export function preview({ evm, solana }: WalletAddresses): string {
  return [evm, solana && `${solana} on Solana`].filter(Boolean).join(" and ");
}

/**
 * What's worth knowing before bringing these keys in, kept to what could change the owner's
 * mind: an account another wallet's code runs, and that the keys may not be theirs alone.
 */
export async function notes(
  { evm }: WalletAddresses,
  delegatedElsewhere: (evm: Address) => Promise<string[]> = delegatedOtherwise,
): Promise<string[]> {
  const chains = evm ? await delegatedElsewhere(evm as Address) : [];
  return [
    ...(chains.length > 0
      ? [
          `On ${chains.join(", ")} this account runs another wallet's code (EIP-7702): your first ` +
            "all-or-nothing move there switches it to MetaMask's DeleGator.",
        ]
      : []),
    "auni.io can still use these keys too.",
  ];
}

/** What's worth knowing before bringing a Solana key in beside the wallet's EVM key. */
export const SOLANA_NOTES = ["auni.io can still use this key too."];

/** Each EVM chain Auni uses where the account's code is a delegation to anything but the DeleGator. */
async function delegatedOtherwise(evm: Address): Promise<string[]> {
  const found = await Promise.all(
    EVM_CHAIN_KEYS.map(async (key) => {
      const code = await evmClient(NETWORKS[key].viem.id)
        .getCode({ address: evm })
        .catch(() => undefined);
      const other = code?.toLowerCase().startsWith("0xef0100") && code.toLowerCase() !== DELEGATED;
      return other ? [NETWORKS[key].name] : [];
    }),
  );
  return found.flat();
}
