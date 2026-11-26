import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  hexToBigInt,
  isAddressEqual,
  numberToHex,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type StateOverride,
  zeroAddress,
} from "viem";

import { chainKey, evmClient, publicRpcClient } from "./chains.ts";
import { EVM_NATIVE } from "./fill-key.ts";
import { formatAmount, shortAddress } from "./format.ts";
import type { EvmTx } from "./recipe.ts";
import { feedListing } from "./token-feeds.ts";

// What a batch does to the owner's wallet, read from the logs it emits: a
// simulation's, for a card and to hold bytes to it before they're signed (see
// effect.ts), and a receipt's for fills.

/** A token moving on any chain, named by its address there: an EVM contract or a Solana mint. */
export interface TokenLeg {
  readonly token: string;
  readonly amount: bigint;
}

/** What a transaction sends and gets, on any chain. */
export interface Moved {
  readonly out: readonly TokenLeg[];
  readonly in: readonly TokenLeg[];
}

/** A permission over the owner's tokens left to someone, on any chain. */
export interface TokenGrant {
  readonly kind: "spend" | "operator" | "ownership";
  readonly token: string;
  readonly to: string;
}

/** What a transaction does to the owner's wallet, on any chain, as a simulation or a receipt reads it. */
export interface Simulated extends Moved {
  readonly grants: readonly TokenGrant[];
  /**
   * Who what left the wallet went to, when Auni can name who keeps it: absent
   * on Solana, which doesn't say, and when it went to a contract (see simulateEffect).
   */
  readonly sentTo?: readonly string[];
}

export interface Leg extends TokenLeg {
  readonly token: Address;
}

/** A permission over the owner's assets, and the read that says whether it outlives the batch. */
interface Grant extends TokenGrant {
  readonly token: Address;
  readonly to: Address;
  readonly check?: { readonly to: Address; readonly data: Hex };
}

export interface WalletEffect extends Simulated {
  readonly out: readonly Leg[];
  readonly in: readonly Leg[];
  readonly grants: readonly Grant[];
  /** Everyone the wallet's assets went to; simulateEffect keeps it only for who keeps them. */
  readonly sentTo?: readonly Address[];
}

export interface SimulatedEffect extends WalletEffect {
  /** A call in the batch did something Auni can't read (see `seen`), so a tap can't vouch for it. */
  readonly blind: boolean;
  /** Every log the batch emitted, for a recipe to find what its own venue said (a bridge reads its deposit). */
  readonly logs: readonly Log[];
}

export interface TokenName {
  readonly symbol: string;
  readonly decimals: number;
  /** What people call it: "Wrapped Pearl". */
  readonly name?: string;
  /** Its price per token from a listing Auni trusts: a token feed's, or Solana's token listing's verified tokens. */
  readonly usd?: number;
}

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const TRANSFER_SINGLE = toEventSelector("TransferSingle(address,address,address,uint256,uint256)");
const TRANSFER_BATCH = toEventSelector(
  "TransferBatch(address,address,address,uint256[],uint256[])",
);
const APPROVAL = toEventSelector("Approval(address,address,uint256)");
const PERMIT2_APPROVAL = toEventSelector("Approval(address,address,address,uint160,uint48)");
const PERMIT2_PERMIT = toEventSelector("Permit(address,address,address,uint160,uint48,uint48)");
const APPROVAL_FOR_ALL = toEventSelector("ApprovalForAll(address,address,bool)");
const DEPOSIT = toEventSelector("Deposit(address,uint256)");
const WITHDRAWAL = toEventSelector("Withdrawal(address,uint256)");
const OWNERSHIP = toEventSelector("OwnershipTransferred(address,address)");
const OWNERSHIP_STARTED = toEventSelector("OwnershipTransferStarted(address,address)");
// A lending market's credit delegation, or Morpho's authorization, lets someone else move the owner's positions.
const BORROW_DELEGATION = toEventSelector(
  "BorrowAllowanceDelegated(address,address,address,uint256)",
);
const MORPHO_AUTHORIZATION = toEventSelector("SetAuthorization(address,address,address,bool)");
// An ERC-777 operator can move all the holder's tokens. It's indexed before the holder,
// the other way round from ApprovalForAll.
const AUTHORIZED_OPERATOR = toEventSelector("AuthorizedOperator(address,address)");
const REVOKED_OPERATOR = toEventSelector("RevokedOperator(address,address)");

const reads = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)",
  "function getApproved(uint256 tokenId) view returns (address)",
]);

// Any contract can emit these, so a short topic or data reads as zero rather than throwing,
// and a batch that won't decode is skipped.
const topicAddress = (topic: Hex): Address => getAddress(`0x${topic.slice(-40).padStart(40, "0")}`);
const word = (data: Hex, index = 0): bigint =>
  BigInt(`0x${data.slice(2 + index * 64, 66 + index * 64) || "0"}`);

/**
 * What the logs did to `owner`'s wallet: assets out and in, netted per token
 * so a little coming back doesn't hide a send, permissions granted, and
 * everyone its assets went to. An NFT is one of a kind, so one coming back
 * never nets out another that left.
 */
export function walletEffect(logs: readonly Log[], owner: Address): WalletEffect {
  return read(logs, owner).effect;
}

/**
 * Whether Auni can say what one call did to the wallet: it moved an asset or a
 * permission, and when nothing left the wallet, every asset it moved landed
 * there (a claim, fees collected, a loan, a permission taken back). Else it
 * may send what an app holds for the wallet, such as collateral, elsewhere.
 * Known limit: a call that sends something out is read by what it nets, so it
 * can hide an app's holding leaving within it.
 */
function seen(logs: readonly Log[], owner: Address): boolean {
  const { effect, touched } = read(logs, owner);
  const landsHere = ({ topics: [selector, , two, three] }: Log) => {
    if (selector !== TRANSFER && selector !== TRANSFER_SINGLE && selector !== TRANSFER_BATCH)
      return true;
    const to = selector === TRANSFER ? two : three;
    return !to || isAddressEqual(topicAddress(to), owner);
  };
  return touched && (effect.out.length > 0 || logs.every(landsHere));
}

function read(logs: readonly Log[], owner: Address) {
  const out = new Map<Address, bigint>();
  const into = new Map<Address, bigint>();
  const nftsOut = new Map<Address, bigint>();
  const nftsIn = new Map<Address, bigint>();
  const sentTo = new Set<Address>();
  const grants = new Map<string, Grant | null>();
  const add = (legs: Map<Address, bigint>, token: Address, amount: bigint) =>
    legs.set(token, (legs.get(token) ?? 0n) + amount);
  const mine = (topic: Hex | undefined) =>
    topic !== undefined && isAddressEqual(topicAddress(topic), owner);
  const move = (
    token: Address,
    from: Hex | undefined,
    to: Hex | undefined,
    amount: bigint,
    nft = false,
  ) => {
    if (mine(from) && !mine(to)) {
      add(nft ? nftsOut : out, token, amount);
      if (to) sentTo.add(topicAddress(to));
    }
    if (mine(to) && !mine(from)) add(nft ? nftsIn : into, token, amount);
  };

  for (const { address, topics, data } of logs) {
    const contract = getAddress(address);
    const [selector, one, two, three] = topics;
    if (selector === TRANSFER) {
      // An NFT indexes its token id as a fourth topic and moves one.
      move(contract, one, two, three ? 1n : word(data), three !== undefined);
    } else if (selector === TRANSFER_SINGLE) {
      move(contract, two, three, word(data, 1), true);
    } else if (selector === TRANSFER_BATCH && (mine(two) || mine(three))) {
      try {
        const [, values] = decodeAbiParameters(parseAbiParameters("uint256[], uint256[]"), data);
        move(
          contract,
          two,
          three,
          values.reduce((sum, value) => sum + value, 0n),
          true,
        );
      } catch {
        continue;
      }
    } else if (selector === DEPOSIT && mine(one)) {
      add(into, contract, word(data));
    } else if (selector === WITHDRAWAL && mine(one)) {
      add(out, contract, word(data));
    } else if ((selector === AUTHORIZED_OPERATOR || selector === REVOKED_OPERATOR) && mine(two)) {
      const to = topicAddress(one!);
      const authorized = selector === AUTHORIZED_OPERATOR;
      grants.set(
        `${contract}:${to}`,
        authorized ? { kind: "operator", token: contract, to } : null,
      );
    } else if (!mine(one) || !two) {
      continue;
    } else if (selector === APPROVAL) {
      const to = topicAddress(two);
      // An approval to no one, as clearing an NFT's or burning one logs, grants nothing.
      if (isAddressEqual(to, zeroAddress)) {
        grants.set(`${contract}:${to}:${three}`, null);
        continue;
      }
      // An NFT's approval indexes the token id; it lasts until that token moves.
      const data = three
        ? encodeFunctionData({ abi: reads, functionName: "getApproved", args: [BigInt(three)] })
        : encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, to] });
      const check = { to: contract, data };
      grants.set(`${contract}:${to}:${three}`, { kind: "spend", token: contract, to, check });
    } else if ((selector === PERMIT2_APPROVAL || selector === PERMIT2_PERMIT) && three) {
      const [token, to] = [topicAddress(two), topicAddress(three)];
      const args = [owner, token, to] as const;
      const check = {
        to: contract,
        data: encodeFunctionData({ abi: reads, functionName: "allowance", args }),
      };
      grants.set(`${contract}:${token}:${to}`, { kind: "spend", token, to, check });
    } else if (selector === APPROVAL_FOR_ALL) {
      const to = topicAddress(two);
      grants.set(
        `${contract}:${to}`,
        word(data) ? { kind: "operator", token: contract, to } : null,
      );
    } else if ((selector === OWNERSHIP || selector === OWNERSHIP_STARTED) && !mine(two)) {
      grants.set(contract, { kind: "ownership", token: contract, to: topicAddress(two) });
    } else if (selector === BORROW_DELEGATION && three) {
      const [to, token] = [topicAddress(two), topicAddress(three)];
      grants.set(`${contract}:${to}:${token}`, word(data) ? { kind: "spend", token, to } : null);
    } else if (selector === MORPHO_AUTHORIZATION && three) {
      const to = topicAddress(three);
      grants.set(
        `${contract}:${to}`,
        word(data) ? { kind: "operator", token: contract, to } : null,
      );
    }
  }
  const net = (sums: Map<Address, bigint>, against: Map<Address, bigint>) =>
    [...sums].flatMap(([token, amount]) => {
      const left = amount - (against.get(token) ?? 0n);
      return left > 0n ? [{ token, amount: left }] : [];
    });
  // One leg per token: an ERC-404 token logs both kinds of Transfer for one move.
  const legs = (fungible: readonly Leg[], nfts: Map<Address, bigint>): Leg[] => {
    const sums = new Map(fungible.map(({ token, amount }) => [token, amount]));
    for (const [token, amount] of nfts) add(sums, token, amount);
    return [...sums].map(([token, amount]) => ({ token, amount }));
  };
  const effect: WalletEffect = {
    out: legs(net(out, into), nftsOut),
    in: legs(net(into, out), nftsIn),
    grants: [...grants.values()].filter((each) => each !== null),
    sentTo: [...sentTo],
  };
  // Anything moved or permitted at all, even if it netted out or was taken back.
  const touched = [out, into, nftsOut, nftsIn, grants].some(({ size }) => size > 0);
  return { effect, touched };
}

/** What one simulated block answered for each call, in order. */
type CallResults = Awaited<ReturnType<PublicClient["simulateBlocks"]>>[number]["calls"];

/** Auni's RPC for a chain, then, where that is Alchemy, its public ones; none for a chain Auni can't read. */
function rpcClients(chainId: number): readonly PublicClient[] {
  try {
    return [evmClient(chainId), publicRpcClient(chainId)].filter((client) => client !== null);
  } catch {
    return [];
  }
}

/**
 * Runs the calls in one simulated block (eth_simulateV1), over `state` when
 * given: on each of rpcClients in turn. Each offers the fees a real
 * send would, where the chain takes them, so a contract can't tell the
 * simulation from the send by its gas price. Monad rejects `validation: false`,
 * so validation is left at its default. Null when no RPC could run them.
 */
async function simulateCalls(
  chainId: number,
  calls: readonly { account: Address; to: Address; data?: Hex; value?: bigint }[],
  state?: StateOverride,
): Promise<CallResults | null> {
  const run = async (client: PublicClient) => {
    const fees = await client.estimateFeesPerGas().catch(() => null);
    const block = (priced: boolean) =>
      client
        .simulateBlocks({
          blocks: [
            {
              calls: calls.map((call) =>
                priced && fees
                  ? {
                      ...call,
                      maxFeePerGas: fees.maxFeePerGas,
                      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                    }
                  : call,
              ),
              ...(state?.length ? { stateOverrides: state } : {}),
            },
          ],
          traceTransfers: true,
        })
        .then(([answer]) => answer?.calls ?? null);
    return fees ? block(true).catch(() => block(false)) : block(false);
  };
  for (const client of rpcClients(chainId)) {
    const answer = await run(client).catch(() => null);
    if (answer?.length === calls.length) return answer;
  }
  return null;
}

/** Money a simulation starts with already landed: `amount` of an ERC-20, held by `holder`. */
interface Arriving {
  readonly token: Address;
  readonly holder: Address;
  readonly amount: bigint;
}

/**
 * `state` with `holder` holding just `amount` of `token`, for simulating what
 * money landing there does: the token's own storage slot for that balance,
 * found among those its balanceOf reads as the one that, set, reads back as
 * it when `from`, who the simulation runs from, reads it. Null when none does
 * (a token keeping balances some other way) or no RPC can say, so nothing is
 * judged by a guess.
 *
 * Which slots a balanceOf reads is the same whoever asks, so the node is asked as the zero
 * address and with no fee named, the one way every chain's nodes answer: some refuse a sender
 * who couldn't pay for the read (Arbitrum's, BNB Chain's), and the zero address holds burnt coin
 * on every chain; some refuse a fee of zero (Arbitrum's, Polygon's). Asked at no fee from an
 * account with no coin, Arbitrum and Polygon answered nothing, so no bridge that swaps as it
 * lands there could be checked (probed on each chain's public RPCs, November 2026).
 */
async function arrivedState(
  chainId: number,
  from: Address,
  { token, holder, amount }: Arriving,
  state: StateOverride,
): Promise<StateOverride | null> {
  const read = {
    account: from,
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
  };
  for (const client of rpcClients(chainId)) {
    const listed = await client
      .createAccessList({ account: zeroAddress, to: token, data: read.data })
      .catch(() => null);
    if (!listed) continue;
    const slots = listed.accessList.flatMap((entry) =>
      isAddressEqual(entry.address, token) ? entry.storageKeys : [],
    );
    for (const slot of slots) {
      const arrived: StateOverride = [
        ...state,
        { address: token, stateDiff: [{ slot, value: numberToHex(amount, { size: 32 }) }] },
      ];
      const [held] = (await simulateCalls(chainId, [read], arrived)) ?? [];
      if (held?.status === "success" && held.data !== "0x" && hexToBigInt(held.data) === amount)
        return arrived;
    }
    return null;
  }
  return null;
}

/**
 * Who keeps what went to `sentTo`, as far as Auni can say: each of them, when
 * every one is an account, which keeps what it gets, or a token's own contract
 * sent that token (`sent`), which keeps it for good; none when any is another
 * contract, which can pass it on to whoever its calldata names (a bridge's
 * recipient on another chain, say), or when that can't be read. An account
 * delegated under EIP-7702 runs code, but what it gets is still its key's.
 */
async function holders(
  chainId: number,
  sentTo: readonly Address[],
  sent: readonly string[],
): Promise<readonly Address[] | undefined> {
  try {
    const client = evmClient(chainId);
    const codes = await Promise.all(sentTo.map((address) => client.getCode({ address })));
    const tokens = new Set(sent.map((token) => token.toLowerCase()));
    const keeps = (code: Hex | undefined, at: number) =>
      !code ||
      code === "0x" ||
      code.startsWith("0xef0100") ||
      tokens.has(sentTo[at]!.toLowerCase());
    return codes.every(keeps) ? sentTo : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A move that reverted when Auni ran it first, in the owner's words: the move they allowed is one
 * thing, however many calls it sends, so the sentence says "it". Which call failed (`step` of
 * `of`) is for the agent, about a batch it built itself.
 */
export class WouldFail extends Error {
  readonly step: number;
  readonly of: number;
  /** `cause` is what it reverted with, for the app whose contract it is (revertOf in refused.ts). */
  constructor(step: number, of: number, reason: string | undefined, cause: unknown) {
    super(
      `A simulation showed it would fail${reason ? ` ("${reason}")` : ""}, so Auni didn't send it.`,
      { cause },
    );
    this.step = step;
    this.of = of;
  }
}

/** Coin a simulation gives an account sending it for someone else, far more than any gas costs. */
const GAS_MONEY = 10n ** 30n;

/**
 * Simulates what the batch does to the owner's wallet, sent from the owner or
 * from `from` when given (an account, as Monad simulates nothing a contract
 * sends, given coin for its gas), with money `arriving` already landed when
 * given; null when no RPC can. A call that reverts throws, naming it,
 * since sending it would only spend gas. An approval counts only if it
 * outlives the batch: one the move spends to nothing drops out, though not
 * every token logs that spend. Where what left went is named only for who
 * keeps it (see holders).
 */
export async function simulateEffect(
  chainId: number,
  owner: Address,
  calls: readonly EvmTx[],
  { arriving, from = owner }: { readonly arriving?: Arriving; readonly from?: Address } = {},
): Promise<SimulatedEffect | null> {
  const sent = calls.map(({ to, data, value }) => ({
    account: from,
    to: to as Address,
    ...(data ? { data: data as Hex } : {}),
    ...(value ? { value: BigInt(value) } : {}),
  }));
  const funded: StateOverride = isAddressEqual(from, owner)
    ? []
    : [{ address: from, balance: GAS_MONEY }];
  const state = arriving ? await arrivedState(chainId, from, arriving, funded) : funded;
  if (state === null) return null;
  const results = await simulateCalls(chainId, sent, state);
  if (!results) return null;
  const failed = results.findIndex(({ status }) => status !== "success");
  if (failed >= 0) {
    const error = results[failed]?.error;
    const reverted =
      error instanceof BaseError
        ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
        : null;
    const reason = reverted instanceof ContractFunctionRevertedError ? reverted.reason : undefined;
    throw new WouldFail(failed + 1, sent.length, reason, error);
  }
  const logs = results.flatMap((result) => result.logs ?? []);
  const { sentTo = [], ...moved } = walletEffect(logs, owner);
  const kept = await holders(
    chainId,
    sentTo,
    moved.out.map(({ token }) => token),
  );
  const effect: SimulatedEffect = {
    ...moved,
    ...(kept ? { sentTo: kept } : {}),
    blind: results.some((result) => !seen(result.logs ?? [], owner)),
    logs,
  };
  const checked = effect.grants.flatMap(({ check }) => (check ? [check] : []));
  if (!checked.length) return effect;
  const after = await simulateCalls(
    chainId,
    [...sent, ...checked.map((check) => ({ account: from, ...check }))],
    state,
  );
  if (!after || after.some(({ status }) => status !== "success")) return null;
  const left = new Map(
    checked.map((check, index) => [check, word(after[sent.length + index]!.data)]),
  );
  return { ...effect, grants: effect.grants.filter(({ check }) => !check || left.get(check)) };
}

/** Dollars at the listed prices; a token without one adds nothing. */
export function worth(legs: readonly TokenLeg[], names: ReadonlyMap<string, TokenName>): number {
  return legs.reduce((sum, { token, amount }) => {
    const name = names.get(token);
    return sum + (name?.usd ? Number(formatUnits(amount, name.decimals)) * name.usd : 0);
  }, 0);
}

/** "0x1a2b3c…9f8e spend your USDC": who holds the permission, and what it lets them do. */
export function grantLabel(grant: TokenGrant, names: ReadonlyMap<string, TokenName>): string {
  const to = shortAddress(grant.to);
  if (grant.kind === "ownership") return `${to} own ${shortAddress(grant.token)}`;
  const token = tokenLabel(grant.token, names);
  return grant.kind === "spend" ? `${to} spend your ${token}` : `${to} move all your ${token}`;
}

/**
 * Symbol, decimals and price of every token the effect touches: a token feed's listing
 * when one has it priced, else the contract's own say, unpriced. One that can't be read is left out.
 */
export async function tokenNames(
  chainId: number,
  effect: WalletEffect | null,
): Promise<Map<Address, TokenName>> {
  const tokens = new Set(
    [...(effect?.out ?? []), ...(effect?.in ?? []), ...(effect?.grants ?? [])].map(
      ({ token }) => token,
    ),
  );
  const names = new Map<Address, TokenName>();
  await Promise.all(
    [...tokens].map(async (token) => {
      const listed = await feedListing(chainKey(chainId), token).catch(() => null);
      if (listed?.usdPrice) {
        const { symbol, decimals, name, usdPrice: usd } = listed;
        names.set(token, { symbol, decimals, name, usd });
        return;
      }
      try {
        if (token === EVM_NATIVE) {
          const coin = evmClient(chainId).chain?.nativeCurrency;
          if (coin) names.set(token, coin);
          return;
        }
        const read = (functionName: "symbol" | "decimals") =>
          evmClient(chainId).readContract({ address: token, abi: erc20Abi, functionName });
        // An NFT has a symbol but no decimals; any other failure leaves the token unread.
        const noDecimals = (error: unknown) => {
          const missing = (cause: unknown) =>
            cause instanceof ContractFunctionRevertedError ||
            cause instanceof ContractFunctionZeroDataError;
          if (error instanceof BaseError && error.walk(missing)) return 0;
          throw error;
        };
        const [symbol, decimals] = await Promise.all([
          read("symbol"),
          read("decimals").catch(noDecimals),
        ]);
        names.set(token, { symbol: String(symbol), decimals: Number(decimals) });
      } catch {
        // Shown by its address instead.
      }
    }),
  );
  return names;
}

function tokenLabel(token: string, names: ReadonlyMap<string, TokenName>): string {
  return names.get(token)?.symbol ?? shortAddress(token);
}

/** "5 USDC, 0.0012 WETH", or raw units for a token that couldn't be read. */
export function amounts(legs: readonly TokenLeg[], names: ReadonlyMap<string, TokenName>): string {
  return legs
    .map(({ token, amount }) => {
      const name = names.get(token);
      const value = name
        ? formatAmount(Number(formatUnits(amount, name.decimals)))
        : String(amount);
      return `${value} ${tokenLabel(token, names)}`;
    })
    .join(", ");
}
