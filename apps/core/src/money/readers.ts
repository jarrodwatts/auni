import { EVM_CHAIN_KEYS, appListing, type EvmChainKey } from "@auni/shared";
import { decodeFunctionData, erc20Abi, type Address } from "viem";

import type { App, BuiltCall, Reading } from "../apps/contract.ts";
import { apps } from "../apps/registry.ts";
import type { Simulated } from "./wallet-effect.ts";

// A transaction the agent built names its app and its words itself, and nothing checks them. An
// app whose own contracts the whole batch calls vouches for both instead: its own name and logo,
// and its reader's few words. Neither touches what the card shows moving or how it is allowed,
// which come from the simulation alone (money/recipes/evm.ts).

/** Each app's names for addresses on `chain` (see App.addresses); one that can't say names none. */
export async function addressBook(
  chain: EvmChainKey,
  owner: Address,
): Promise<readonly { readonly app: App; readonly names: ReadonlyMap<string, string> }[]> {
  // Every app, switched off or not: what a contract is doesn't change with the switch.
  const named = apps().filter((app) => app.addresses);
  return Promise.all(
    named.map(async (app) => ({
      app,
      names: await app.addresses!(chain, owner).catch(() => new Map<string, string>()),
    })),
  );
}

/** An app whose contracts a batch calls, on the chain where it knows them. */
export interface KnownAt {
  readonly app: App;
  readonly chain: EvmChainKey;
  /** What the app calls the contract the batch ends at: "Lido's staking contract". */
  readonly callee: string;
}

/**
 * The app the whole batch is for: every call goes to one of its `addresses` on `chain`, or
 * approves one of them to spend a token, and the last goes to one. Null when no app's are all
 * of it, or on a chain Auni names no app on. So an app never vouches for a call to anyone else:
 * a batch that pays a stranger before it stakes reads as the plain card, not as the stake.
 */
export async function appFor(
  chain: string,
  owner: Address,
  calls: readonly BuiltCall[],
): Promise<KnownAt | null> {
  const key = EVM_CHAIN_KEYS.find((each) => each === chain);
  const last = calls.at(-1);
  if (!key || !last) return null;
  const known = (await addressBook(key, owner)).find(
    ({ names }) =>
      names.has(last.to.toLowerCase()) &&
      calls.every(({ to, data }) => {
        const target = approvedSpender(data) ?? to;
        return names.has(target.toLowerCase());
      }),
  );
  return known
    ? { app: known.app, chain: key, callee: known.names.get(last.to.toLowerCase())! }
    : null;
}

/** A name as it is compared: its letters and digits, in lower case. */
const bare = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The name of the app of Auni's that a hint the agent wrote names, by the app's name or id or by
 * the site's own name (for an app named Fake Perps: "Fake Perps", "fakeperps.xyz"), switched on
 * or off; null when it names none. Asked only of a transaction no app vouches for (see appFor), so its card says that app
 * doesn't know the contract, rather than that Auni has no app for the service.
 */
export function appNamed(name: string, site: string | null): string | null {
  const said = [name, ...(site ? [site.split(".").at(-2) ?? ""] : [])].map(bare).filter(Boolean);
  const named = apps().find(({ about }) =>
    [about.name, about.id].some((known) => said.includes(bare(known))),
  );
  return named?.about.name ?? null;
}

/** Whom an ERC-20 approve lets spend, read from its calldata; null for any other call. */
function approvedSpender(data: BuiltCall["data"]): Address | null {
  try {
    const call = decodeFunctionData({ abi: erc20Abi, data });
    return call.functionName === "approve" ? call.args[0] : null;
  } catch {
    return null;
  }
}

/** The app a transaction the agent built is for, as the app whose contracts it calls says. */
export interface Vouched {
  /** As people know it: the app's name. */
  readonly name: string;
  /** The app's own logo, as the web serves it; null when it has none. */
  readonly logo: string | null;
  /** What its reader said of the transaction; null when it has no reader or said nothing. */
  readonly reading: Reading | null;
}

/** What the app a whole batch is for vouches for: its name, its logo, its reader's words (see appFor). */
export function vouched(
  { app, chain }: KnownAt,
  calls: readonly BuiltCall[],
  seen: Simulated | null,
): Vouched {
  return {
    name: app.about.name,
    logo: appListing(app.about.id)?.logo ?? null,
    // A reader reads only what a simulation saw: with none, there is nothing for it to name.
    reading: seen ? readingOf(app, chain, calls, seen) : null,
  };
}

/** The longest title a reader may give: what the agent's own summary may be. */
const TITLE_MAX = 160;

/**
 * What an app's reader says of a simulated transaction, or null when it has no reader, throws,
 * says nothing, or gives words a card can't carry: a title that types a dollar amount of its
 * own, or one too long. The card is then the plain one, still under the app's name.
 */
function readingOf(
  app: App,
  chain: EvmChainKey,
  calls: readonly BuiltCall[],
  seen: Simulated,
): Reading | null {
  let reading: Reading | null;
  try {
    reading = app.reads?.(chain, calls, seen) ?? null;
  } catch {
    return null;
  }
  if (!reading) return null;
  const title = reading.title?.trim();
  if (title !== undefined && (!title || title.length > TITLE_MAX || /\$\s*\d/u.test(title)))
    return null;
  return {
    ...(title ? { title } : {}),
    verb: reading.verb.slice(0, 24),
    ...(reading.toChain ? { toChain: reading.toChain.slice(0, 40) } : {}),
    ...(reading.finePrint ? { finePrint: reading.finePrint.slice(0, 300) } : {}),
  };
}
