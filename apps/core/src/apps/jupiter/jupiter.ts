import { setTimeout as sleep } from "node:timers/promises";

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";

import { requiredSetting } from "../../settings.ts";
import about from "./about.ts";
import type { SolanaPrice, SolanaQuote, SolanaQuoteRequest, SolanaToken } from "../contract.ts";
import { cached, fetchJson, HttpError } from "../../money/swaps/shared.ts";

export const JUPITER_API = "https://api.jup.ag";
const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");

interface JupiterTokenRow {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  readonly icon?: string;
  readonly usdPrice?: number;
  readonly liquidity?: number;
  readonly isVerified?: boolean;
  readonly organicScore?: number;
  readonly tags?: string[];
  readonly stats24h?: { readonly buyVolume?: number; readonly sellVolume?: number };
}

const JUPITER_TRIES = 5;

async function jupiter<T>(
  path: string,
  params: Record<string, string>,
  timeoutMs?: number,
): Promise<T> {
  const key = requiredSetting(about, "apiKey");
  const url = new URL(path, JUPITER_API);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchJson<T>(url, { timeoutMs, init: { headers: { "x-api-key": key } } });
    } catch (error) {
      // Jupiter rate-limits bursts (429); a short backoff usually clears it.
      if (!(error instanceof HttpError) || error.status !== 429 || attempt >= JUPITER_TRIES)
        throw error;
      await sleep(400 * 2 ** attempt + Math.random() * 300);
    }
  }
}

function toSolanaToken(row: JupiterTokenRow): SolanaToken {
  const volume = (row.stats24h?.buyVolume ?? 0) + (row.stats24h?.sellVolume ?? 0);
  return {
    mint: address(row.id),
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    tokenProgram: address(row.tokenProgram),
    usdPrice: row.usdPrice ?? null,
    liquidityUsd: row.liquidity ?? null,
    volume24hUsd: row.stats24h ? volume : null,
    logoUrl: row.icon ?? null,
    verified: row.isVerified === true,
    organicScore: row.organicScore ?? 0,
    tags: row.tags ?? [],
  };
}

/** Jupiter's token search: a symbol, a name, or up to 100 comma-separated mints. */
const tokenSearch = cached(60_000, async (query) => {
  const rows = await jupiter<JupiterTokenRow[]>("/tokens/v2/search", { query }, 4_000);
  return rows.map(toSolanaToken);
});

export function searchSolanaTokens(query: string): Promise<SolanaToken[]> {
  return tokenSearch(query.trim());
}

interface ScaledUiConfig {
  readonly multiplier: number;
  readonly newMultiplier?: number;
  readonly newMultiplierEffectiveAt?: string;
}

interface JupiterPrice {
  /** The token's last swap, which for a stock nobody trades can be far from its share's price. */
  readonly usdPrice: number;
  /** An xStock's share price, as xStocks gives it. */
  readonly stockData?: { readonly price?: number };
  readonly scaledUiConfig?: ScaledUiConfig;
}

/**
 * A token's price, as Auni values what it holds and what a trade gets: for an xStock, its
 * share's price rather than its token's last swap. JNJx last swapped at $242.74 in a pool
 * with $18 in it while J&J traded at $278.97, so a fair fill read as a 13% loss.
 */
export const solanaPrice = cached(30_000, async (mint): Promise<SolanaPrice> => {
  const prices = await jupiter<Record<string, JupiterPrice | undefined>>("/price/v3", {
    ids: mint,
  });
  const price = prices[mint];
  const share = price?.stockData?.price;
  const usdPrice =
    share !== undefined && Number.isFinite(share) && share > 0 ? share : price?.usdPrice;
  if (!price || usdPrice === undefined || !Number.isFinite(usdPrice))
    throw new Error(`Jupiter has no price for ${mint}`);
  // The mint switches to its new multiplier at the time it names and keeps the
  // old one on record, so `multiplier` alone goes stale after a corporate action.
  const scaled = price.scaledUiConfig;
  const switched =
    scaled?.newMultiplier !== undefined &&
    Date.parse(scaled.newMultiplierEffectiveAt ?? "") <= Date.now();
  return {
    usdPrice,
    multiplier: (switched ? scaled.newMultiplier : scaled?.multiplier) ?? 1,
  };
});

interface JupiterQuoteResponse {
  readonly inAmount: string;
  readonly outAmount: string;
  readonly otherAmountThreshold: string;
  readonly priceImpactPct: string;
  readonly routePlan: readonly { readonly swapInfo: { readonly label: string } }[];
}

function readQuote(response: JupiterQuoteResponse): SolanaQuote {
  return {
    inAmount: BigInt(response.inAmount),
    outAmount: BigInt(response.outAmount),
    minOutAmount: BigInt(response.otherAmountThreshold),
    priceImpactPct: Number(response.priceImpactPct) * 100,
    route: [...new Set(response.routePlan.map((leg) => leg.swapInfo.label))].join(" + "),
  };
}

function quoteParams(request: SolanaQuoteRequest): Record<string, string> {
  return {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount.toString(),
    slippageBps: String(request.slippageBps),
    // Leaves room under Solana's 1232-byte limit for a sponsor's fee payer.
    maxAccounts: "40",
  };
}

/** Same Metis router `/swap/v2/build` uses, without needing a taker. */
export async function quoteSwap(request: SolanaQuoteRequest): Promise<SolanaQuote> {
  return readQuote(await jupiter<JupiterQuoteResponse>("/swap/v1/quote", quoteParams(request)));
}

interface WireInstruction {
  readonly programId: string;
  readonly accounts: readonly {
    readonly pubkey: string;
    readonly isSigner: boolean;
    readonly isWritable: boolean;
  }[];
  readonly data: string;
}

interface JupiterBuild extends JupiterQuoteResponse {
  readonly computeBudgetInstructions: readonly WireInstruction[];
  readonly setupInstructions: readonly WireInstruction[];
  readonly swapInstruction: WireInstruction;
  readonly cleanupInstruction?: WireInstruction | null;
  readonly otherInstructions: readonly WireInstruction[];
  readonly addressesByLookupTableAddress: Record<string, string[]> | null;
  readonly blockhashWithMetadata: {
    readonly blockhash: number[];
    readonly lastValidBlockHeight: number;
  };
}

function decodeInstruction(wire: WireInstruction): Instruction {
  return {
    programAddress: address(wire.programId),
    data: Buffer.from(wire.data, "base64"),
    accounts: wire.accounts.map((account) => ({
      address: address(account.pubkey),
      role: account.isSigner
        ? account.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : account.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
  };
}

function setComputeUnitLimit(units: number): Instruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}

interface BuiltSwap {
  readonly quote: SolanaQuote;
  readonly transactionBase64: string;
}

/**
 * Builds the owner's swap as one v0 transaction with the owner as fee payer. A wallet with a
 * sponsor swaps in its payer, which funds any account rent too; one that pays its own way
 * pays them in SOL, which the swap buys first when it holds too little (see sol-top-up.ts).
 */
export async function buildSwapTransaction(
  request: SolanaQuoteRequest & { readonly taker: Address },
): Promise<BuiltSwap> {
  const build = await jupiter<JupiterBuild>("/swap/v2/build", {
    ...quoteParams(request),
    taker: request.taker,
  });

  const instructions = [
    // /build returns a price but no limit; the max costs well under 0.0001 SOL at Jupiter's prices.
    setComputeUnitLimit(1_400_000),
    ...build.computeBudgetInstructions.map(decodeInstruction),
    ...build.setupInstructions.map(decodeInstruction),
    decodeInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [decodeInstruction(build.cleanupInstruction)] : []),
    ...build.otherInstructions.map(decodeInstruction),
  ];
  const lookupTables = Object.fromEntries(
    Object.entries(build.addressesByLookupTableAddress ?? {}).map(([table, addresses]) => [
      address(table),
      addresses.map((entry) => address(entry)),
    ]),
  );
  const lifetime = {
    blockhash: getBase58Decoder().decode(
      Uint8Array.from(build.blockhashWithMetadata.blockhash),
    ) as Blockhash,
    lastValidBlockHeight: BigInt(build.blockhashWithMetadata.lastValidBlockHeight),
  };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(request.taker, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
    (draft) => compressTransactionMessageUsingAddressLookupTables(draft, lookupTables),
  );
  return {
    quote: readQuote(build),
    transactionBase64: getBase64EncodedWireTransaction(compileTransaction(message)),
  };
}
