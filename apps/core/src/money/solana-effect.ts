import {
  AccountRole,
  address,
  compileTransaction,
  compileTransactionMessage,
  decompileTransactionMessage,
  fetchAddressesForLookupTables,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isSignerRole,
  isWritableRole,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type TransactionMessage,
  type TransactionMessageWithFeePayer,
} from "@solana/kit";

import { solanaKitRpc, solanaRpc, SPL_TOKEN_PROGRAMS } from "./chains.ts";
import { poll } from "./poll.ts";
import { WRAPPED_SOL } from "./fill-key.ts";
import { shortAddress } from "./format.ts";
import type { Moved, Simulated, TokenGrant } from "./wallet-effect.ts";
import { paysOwnGas } from "./wallets.ts";

// What a Solana transaction does to the owner's wallet, read from the balances
// the chain reports before and after it: a simulation's, for a card and to
// hold bytes to it before they're signed (see effect.ts), and a landed
// transaction's for fills. A transaction can change only the accounts it
// lists, and the chain reports every one of them, so this sees every token and
// SOL movement without trusting any program's logs.

/** A token account's balance, as Solana's RPC reports it on either side of a transaction. */
export interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

/** What Solana's RPC reports around a transaction, simulated or landed. */
export interface Balances {
  /** Its own accounts, then those its lookup tables load, writable first: accountIndex's order. */
  readonly accountKeys: readonly string[];
  /** Lamports its fee payer, the first account, pays. */
  readonly fee: number;
  readonly preBalances: readonly number[];
  readonly postBalances: readonly number[];
  readonly preTokenBalances: readonly TokenBalance[];
  readonly postTokenBalances: readonly TokenBalance[];
}

export interface SolanaEffect extends Moved {
  /** Lamports put into rent for the wallet's own new token accounts, less any it closed. */
  readonly rent: bigint;
}

/**
 * What a transaction did to `owner`'s wallet, netted per mint. SOL is one leg,
 * under its wrapped mint: the wallet's lamports and those of its token
 * accounts, so wrapping, unwrapping and opening or closing its own token
 * accounts move none, while SOL put anywhere else, an app's account rent
 * included, is sent. The fee it pays is the network's, not a leg. A token
 * account handed to someone else drops out, so what it held reads as sent.
 */
export function effectOf(balances: Balances, owner: string): SolanaEffect {
  const { accountKeys, preBalances, postBalances } = balances;
  const net = new Map<string, bigint>();
  const add = (mint: string, amount: bigint) => net.set(mint, (net.get(mint) ?? 0n) + amount);
  const wallet = accountKeys.indexOf(owner);
  add(WRAPPED_SOL, BigInt(postBalances[wallet] ?? 0) - BigInt(preBalances[wallet] ?? 0));
  if (accountKeys[0] === owner) add(WRAPPED_SOL, BigInt(balances.fee));
  let rent = 0n;
  const count = (tokens: readonly TokenBalance[], lamports: readonly number[], sign: bigint) => {
    for (const { accountIndex, mint, owner: holder, uiTokenAmount } of tokens) {
      if (holder !== owner) continue;
      const held = BigInt(lamports[accountIndex] ?? 0) * sign;
      const amount = BigInt(uiTokenAmount.amount) * sign;
      add(WRAPPED_SOL, held);
      // A wrapped SOL account's lamports are its balance and its rent; any other's are rent.
      if (mint === WRAPPED_SOL) {
        rent += held - amount;
      } else {
        add(mint, amount);
        rent += held;
      }
    }
  };
  count(balances.preTokenBalances, preBalances, -1n);
  count(balances.postTokenBalances, postBalances, 1n);
  const legs = (sign: bigint) =>
    [...net].flatMap(([token, amount]) =>
      amount * sign > 0n ? [{ token, amount: amount * sign }] : [],
    );
  return { out: legs(-1n), in: legs(1n), rent };
}

interface LandedTransaction {
  readonly transaction: { readonly message: { readonly accountKeys: { pubkey: string }[] } };
  readonly meta: Omit<Balances, "accountKeys"> | null;
}

/** What a landed transaction did to `owner`'s wallet (see effectOf), once the RPC has it. */
export async function landedEffect(signature: string, owner: string): Promise<SolanaEffect> {
  const effect = await poll(
    async () => {
      const found = await solanaRpc<LandedTransaction | null>("getTransaction", [
        signature,
        { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
      ]);
      if (!found?.meta) return undefined;
      const accountKeys = found.transaction.message.accountKeys.map(({ pubkey }) => pubkey);
      return effectOf({ ...found.meta, accountKeys }, owner);
    },
    { every: 1_000, tries: 10 },
  );
  if (effect) return effect;
  throw new Error(`The Solana transaction ${signature} landed but its balances couldn't be read.`);
}

/** Solana's minimum a paying wallet must keep after: the rent of an account with no data. */
export const SOLANA_KEEP_LAMPORTS = 650_240n;

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
/**
 * Solana's own programs, which an app's transaction calls on its way to the
 * app's program, and whose accounts (the wallet, its tokens) Auni reads itself.
 */
const SOLANA_PROGRAMS = new Set<string>([
  SYSTEM_PROGRAM,
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  ...SPL_TOKEN_PROGRAMS,
]);
/**
 * Programs keeping what a wallet owns in trees many wallets share rather than
 * in an account of its own, so nothing Auni reads shows it move: compressed
 * NFTs (Bubblegum, and the two account compression programs under it).
 */
const SHARED_CUSTODY = new Set<string>([
  "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",
  "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK",
  "mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW",
]);
/**
 * A wallet with plenty of SOL (an exchange's) and a loan from it, which only a
 * simulation ever carries: lent that, a wallet with too little SOL to pay for a
 * transaction shows what it would do, and how much SOL it is short.
 */
const LENDER = address("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const LOAN = 1_000_000_000n;
/** What each signature costs; the loan's own is one the wallet won't pay for. */
const LAMPORTS_PER_SIGNATURE = 5_000n;

interface Simulation extends Omit<Balances, "accountKeys"> {
  readonly err: unknown;
  readonly logs: readonly string[] | null;
  /** Programs it calls from other programs: by id when parsed, else by place in the keys. */
  readonly innerInstructions:
    | readonly {
        readonly instructions: readonly {
          readonly programId?: string;
          readonly programIdIndex?: number;
        }[];
      }[]
    | null;
  readonly loadedAddresses: {
    readonly writable: readonly string[];
    readonly readonly: readonly string[];
  } | null;
  /**
   * After the transaction, the accounts asked for: the wallet, then every one it writes.
   * One no parser reads, like an app's, comes as its bytes in base64.
   */
  readonly accounts: readonly ({
    readonly owner: string;
    readonly space: number;
    readonly data:
      | { readonly parsed?: { readonly type: string; readonly info: TokenAccount } }
      | RawAccount["data"];
  } | null)[];
}

/** An account as the RPC returns it in base64: whose program keeps it, and its bytes. */
interface RawAccount {
  readonly owner: string;
  readonly data: readonly [string, string];
}

interface TokenAccount {
  readonly mint: string;
  readonly owner: string;
  readonly delegate?: string;
  readonly delegatedAmount?: { readonly amount: string };
  readonly closeAuthority?: string;
}

/** What a transaction does as the wallet would send it now, and what that costs the wallet. */
export interface SolanaSimulation {
  readonly effect: Simulated;
  /** Lamports the wallet pays the network, at the price its builder set. */
  readonly fee: bigint;
  /** Lamports the wallet puts into rent for its own new token accounts. */
  readonly rent: bigint;
  /** Lamports of SOL the wallet must buy before it can pay for the transaction itself. */
  readonly short: bigint;
  /** A program keeping an account for the wallet that it changes (see positionAt). */
  readonly position: string | null;
  /** The program it calls last, besides Solana's own: the app it is for. */
  readonly via: string;
  /** Each mint's decimals, as the chain counts them. */
  readonly decimals: ReadonlyMap<string, number>;
  /** The transaction as the wallet signs it, on a fresh blockhash. */
  wire(): Promise<string>;
}

/**
 * Unpacks a transaction someone else built and simulates it from the wallet: on Auni's Solana RPC,
 * then, where that is Alchemy, on Solana's public one (see solanaRpc). Where the wallet pays its
 * own fee and the rent of what it opens, as a wallet with no sponsor always does and any does
 * for a transaction sent with `paysOwnFee` (see Signer.sendSolanaTransaction), a wallet too
 * short of SOL is simulated again lent some to read how short (`short`). Otherwise its sponsor's
 * fee payer pays those, which a wallet short of SOL is lent some to stand in for. Refuses one
 * that fails or hands the wallet itself to a program, and, unless `othersSigned` (a bridge signs
 * its own part of a deposit up front), one that needs another signer.
 *
 * With `setupOnly`, only its instructions to Solana's own programs run: the accounts it opens and
 * its fee, without the app's own instruction. That is what a swap the wallet can't pay for yet
 * spends of its SOL (see solForSwap), as its cash comes by an earlier move on the same card.
 */
export async function simulateSolana(
  transaction: string,
  owner: Address,
  options: {
    readonly othersSigned?: boolean;
    readonly paysOwnFee?: true;
    readonly setupOnly?: true;
  } = {},
): Promise<SolanaSimulation> {
  const othersSigned = options.othersSigned ?? false;
  const paysOwnFee = options.paysOwnFee ?? (await paysOwnGas("solana"));
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(transaction, "base64"));
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const lookups = "addressTableLookups" in compiled ? (compiled.addressTableLookups ?? []) : [];
  const tables = await fetchAddressesForLookupTables(
    lookups.map(({ lookupTableAddress }) => lookupTableAddress),
    solanaKitRpc(),
  );
  // Unpacked, it keeps each account's place in its lookup table, so it packs again the same size.
  const whole = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: tables });
  const message = options.setupOnly
    ? {
        ...whole,
        instructions: whole.instructions.filter(({ programAddress }) =>
          SOLANA_PROGRAMS.has(programAddress),
        ),
      }
    : whole;
  const instructions: readonly Instruction[] = message.instructions;
  const accounts = instructions.flatMap(({ accounts: listed = [] }) => listed);
  // The wallet signs only as itself, and the fresh blockhash voids any signature already on it.
  const others = new Set(
    accounts.flatMap((each) =>
      isSignerRole(each.role) && each.address !== owner ? [shortAddress(each.address)] : [],
    ),
  );
  if (others.size && !othersSigned)
    throw new Error(
      `It needs ${[...others].join(" and ")} to sign as well as the wallet, which Auni can't do. Ask the app for a transaction only the wallet signs.`,
    );
  const ours = setTransactionMessageFeePayer(owner, message);
  const writable = [
    ...new Set([
      owner,
      ...accounts.flatMap((each) => (isWritableRole(each.role) ? [each.address] : [])),
    ]),
  ];
  const simulate = async (draft: TransactionMessage & TransactionMessageWithFeePayer) => {
    const params = [
      getBase64EncodedWireTransaction(compileTransaction(draft)),
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        innerInstructions: true,
        accounts: { encoding: "jsonParsed", addresses: writable },
      },
    ];
    const { value } = await solanaRpc<{ value: Simulation }>("simulateTransaction", params).catch(
      () => solanaRpc<{ value: Simulation }>("simulateTransaction", params, { onPublic: true }),
    );
    const { writable: loaded = [], readonly = [] } = value.loadedAddresses ?? {};
    const keys = [...compileTransactionMessage(draft).staticAccounts, ...loaded, ...readonly];
    return { ...value, accountKeys: keys };
  };
  const [plain, before] = await Promise.all([simulate(ours), positionAt(writable, owner)]);
  const lent = plain.err ? await simulate(lend(ours, owner)).catch(() => null) : null;
  const result = lent ?? plain;
  if (result.err) throw failure(result);
  const [wallet] = result.accounts;
  if (wallet && (wallet.owner !== SYSTEM_PROGRAM || wallet.space > 0))
    throw new Error("It hands the wallet itself to a program, so Auni won't send it.");

  const index = result.accountKeys.indexOf(owner);
  // Read as the wallet will send it: the loan comes off what the wallet ends with, and the
  // wallet pays the fee the lender paid, less the lender's own signature.
  const postBalances = result.postBalances.map((each, at) =>
    at === index && lent ? each - Number(LOAN) : each,
  );
  const fee = BigInt(result.fee) - (lent ? LAMPORTS_PER_SIGNATURE : 0n);
  const { out, in: into, rent } = effectOf({ ...result, postBalances }, owner);
  const ends = BigInt(postBalances[index] ?? 0) - (lent ? fee : 0n);
  let short = 0n;
  if (lent && paysOwnFee) {
    short = ends < SOLANA_KEEP_LAMPORTS ? SOLANA_KEEP_LAMPORTS - ends : 0n;
    // One that ends holding enough yet fails unlent needs SOL along the way (a swap into SOL
    // opens an account before it unwraps), which a wallet paying its own way must hold first.
    if (!short) throw failure(plain);
  }

  const app =
    instructions.findLast(({ programAddress }) => !SOLANA_PROGRAMS.has(programAddress)) ??
    instructions.at(-1);
  const balances = [...result.preTokenBalances, ...result.postTokenBalances];
  return {
    effect: { out, in: into, grants: grants(result, owner) },
    fee,
    rent: rent > 0n ? rent : 0n,
    short,
    // One it opens shows only after; one it empties and closes, only before.
    position: before ?? keeperOf(result.accounts, owner) ?? sharedCustody(instructions, result),
    via: app ? shortAddress(app.programAddress) : "no program",
    decimals: new Map([
      [WRAPPED_SOL, 9],
      ...balances.map(({ mint, uiTokenAmount }) => [mint, uiTokenAmount.decimals] as const),
    ]),
    async wire() {
      const { value: lifetime } = await solanaKitRpc().getLatestBlockhash().send();
      const fresh = setTransactionMessageLifetimeUsingBlockhash(lifetime, ours);
      return getBase64EncodedWireTransaction(compileTransaction(fresh));
    },
  };
}

/**
 * The program, besides Solana's own, keeping one of these accounts with the
 * wallet's address in it: the wallet's position at an app, a stake account, a
 * program it can upgrade. The wallet's signature lets that program change it,
 * and Auni can't read what it holds. An account the RPC parsed rather than
 * leaving as bytes always counts: past tokens, Solana parses only its own
 * stake, vote, lookup table and upgradeable program accounts, whose
 * authorities can be anyone's.
 */
function keeperOf(
  accounts: readonly ({ readonly owner: string; readonly data: unknown } | null)[],
  owner: Address,
): string | null {
  const key = Buffer.from(getAddressEncoder().encode(owner));
  const kept = accounts.find(
    (account) =>
      account &&
      !SOLANA_PROGRAMS.has(account.owner) &&
      (!Array.isArray(account.data) ||
        Buffer.from(String(account.data[0]), "base64").includes(key)),
  );
  return kept?.owner ?? null;
}

/** A program it calls, directly or from another program, that keeps what wallets own in shared trees. */
function sharedCustody(
  instructions: readonly Instruction[],
  result: Pick<Simulation, "innerInstructions"> & { readonly accountKeys: readonly string[] },
): string | null {
  const called = [
    ...instructions.map(({ programAddress }) => programAddress),
    ...(result.innerInstructions ?? []).flatMap(({ instructions: inner }) =>
      inner.map(
        ({ programId, programIdIndex }) => programId ?? result.accountKeys[programIdIndex ?? -1],
      ),
    ),
  ];
  return called.find((program) => program !== undefined && SHARED_CUSTODY.has(program)) ?? null;
}

/** keeperOf the accounts a transaction writes, as they stand before it. */
async function positionAt(writable: readonly Address[], owner: Address): Promise<string | null> {
  const { value } = await solanaRpc<{ value: readonly (RawAccount | null)[] }>(
    "getMultipleAccounts",
    [writable, { encoding: "base64", commitment: "confirmed" }],
  );
  return keeperOf(value, owner);
}

/** The transaction with the loan put in first, paid for by the lender (see LENDER). */
function lend(message: TransactionMessage, owner: Address) {
  const data = new Uint8Array(12);
  // The System program's transfer: its number, then the lamports.
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, LOAN, true);
  return prependTransactionMessageInstruction(
    {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: LENDER, role: AccountRole.WRITABLE_SIGNER },
        { address: owner, role: AccountRole.WRITABLE },
      ],
      data,
    },
    setTransactionMessageFeePayer(LENDER, message),
  );
}

function failure(simulation: Pick<Simulation, "err" | "logs">): Error {
  const said = simulation.logs?.findLast((line) => /error|failed|insufficient/iu.test(line));
  return new Error(
    `It fails in a simulation (${JSON.stringify(simulation.err)}${said ? `: ${said}` : ""}), ` +
      "so it would fail on chain. Build it again rather than editing it.",
  );
}

/**
 * Permissions over the wallet's tokens it leaves: a delegate that can spend
 * them, someone else who can close the account (taking a wrapped SOL account's
 * SOL), and a token account that was the wallet's and is now someone else's.
 */
function grants(result: Simulation, owner: string): TokenGrant[] {
  const left = result.accounts.flatMap((account) => {
    const parsed = account && "parsed" in account.data ? account.data.parsed : undefined;
    const info = parsed?.type === "account" ? parsed.info : null;
    if (info?.owner !== owner) return [];
    const spend = (to: string | undefined) =>
      to && to !== owner ? [{ kind: "spend" as const, token: info.mint, to }] : [];
    return [
      ...spend(BigInt(info.delegatedAmount?.amount ?? 0) > 0n ? info.delegate : undefined),
      ...spend(info.closeAuthority),
    ];
  });
  const after = new Map(result.postTokenBalances.map((each) => [each.accountIndex, each.owner]));
  const handed = result.preTokenBalances.flatMap(({ accountIndex, mint, owner: was }) => {
    const now = after.get(accountIndex);
    return was === owner && now && now !== owner
      ? [{ kind: "operator" as const, token: mint, to: now }]
      : [];
  });
  return [...left, ...handed];
}
