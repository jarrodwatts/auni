import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  numberToHex,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import { formatUnits, parseUnits } from "../../money/usd.ts";
import { POLYGON } from "./http.ts";
import type { TypedData } from "../../money/typed-data.ts";

export const SCALE = 1_000_000n;
// Shares sit on a 0.01 grid on every market.
const SHARE_STEP = 10_000n;
const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;
// POLY_1271: the deposit wallet is maker and signer, verified through ERC-1271.
const DEPOSIT_WALLET_SIGNATURE_TYPE = 3;

const ORDER_FIELDS = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
] as const;
const ORDER_TYPE = `Order(${ORDER_FIELDS.map((field) => `${field.type} ${field.name}`).join(",")})`;

export interface OrderMessage {
  readonly salt: bigint;
  readonly maker: Address;
  readonly signer: Address;
  readonly tokenId: bigint;
  readonly makerAmount: bigint;
  readonly takerAmount: bigint;
  readonly side: 0 | 1;
  readonly signatureType: number;
  readonly timestamp: bigint;
  readonly metadata: Hex;
  readonly builder: Hex;
}

/** A number is rounded to the micro first; a string's extra digits are dropped. */
export function toMicros(value: string | number): bigint {
  return parseUnits(typeof value === "number" ? value.toFixed(6) : value, 6);
}

export function microsText(value: bigint): string {
  return formatUnits(value, 6);
}

export function priceOnTick(priceMicros: bigint, tickMicros: bigint, side: "buy" | "sell"): bigint {
  const down = priceMicros - (priceMicros % tickMicros);
  const price = side === "buy" || down === priceMicros ? down : down + tickMicros;
  if (price < tickMicros || price > SCALE - tickMicros) {
    throw new Error(
      `A Polymarket price must sit between ${microsText(tickMicros)} and ${microsText(SCALE - tickMicros)}.`,
    );
  }
  return price;
}

function amountDecimals(tickMicros: bigint): number {
  return { 100000: 3, 10000: 4, 5000: 5, 2500: 6, 1000: 5, 100: 6 }[Number(tickMicros)] ?? 6;
}

export interface Sized {
  readonly makerAmount: bigint;
  readonly takerAmount: bigint;
}

// Market amounts round like the official client: spent leg to 0.01, received leg down at tick precision.
export function sizeMarket(
  side: "buy" | "sell",
  priceMicros: bigint,
  tickMicros: bigint,
  spend: bigint,
): Sized {
  const spent = spend - (spend % SHARE_STEP);
  const step = 10n ** BigInt(6 - amountDecimals(tickMicros));
  const received = side === "buy" ? (spent * SCALE) / priceMicros : (spent * priceMicros) / SCALE;
  return { makerAmount: spent, takerAmount: received - (received % step) };
}

export interface FeeTerms {
  readonly rateMicros: bigint;
  readonly exponent: bigint;
}

// Polymarket charges r * (p(1-p))^e per share, at most cash * r / 4^(e-1); sells pay from proceeds.
export function buyFeeCeiling(cash: bigint, shares: bigint, fees: FeeTerms): bigint {
  return fees.exponent > 0n
    ? ceilDiv(cash * fees.rateMicros, SCALE * 4n ** (fees.exponent - 1n))
    : ceilDiv(shares * fees.rateMicros, SCALE);
}

/** What a fill of `shares` for `cash` paid in fees at its average price, rounded up. */
export function orderFee(cash: bigint, shares: bigint, fees: FeeTerms): bigint {
  if (shares === 0n) return 0n;
  const price = (cash * SCALE) / shares;
  const spread = (price * (SCALE - price)) / SCALE;
  let perShare = fees.rateMicros;
  for (let power = 0n; power < fees.exponent; power += 1n) perShare = (perShare * spread) / SCALE;
  return ceilDiv(shares * perShare, SCALE);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function newOrder(input: {
  readonly wallet: Address;
  readonly tokenId: bigint;
  readonly side: "buy" | "sell";
  readonly sized: Sized;
}): OrderMessage {
  return {
    // The CLOB reads the salt as a JSON number, so it must stay within MAX_SAFE_INTEGER.
    salt: BigInt(Math.round(Math.random() * Date.now())),
    maker: input.wallet,
    signer: input.wallet,
    tokenId: input.tokenId,
    makerAmount: input.sized.makerAmount,
    takerAmount: input.sized.takerAmount,
    side: input.side === "buy" ? 0 : 1,
    signatureType: DEPOSIT_WALLET_SIGNATURE_TYPE,
    timestamp: BigInt(Date.now()),
    metadata: ZERO_BYTES32,
    // No builder code: the order is credited to no one and carries no builder fee.
    builder: ZERO_BYTES32,
  };
}

/** Signs and settles a market's orders, under this EIP-712 domain version. */
export interface Exchange {
  readonly address: Address;
  readonly version: "2" | "3";
}

function exchangeDomain(exchange: Exchange) {
  return {
    name: "Polymarket CTF Exchange",
    version: exchange.version,
    chainId: POLYGON,
    verifyingContract: exchange.address,
  } as const;
}

// A deposit wallet order is signed as an ERC-7739 envelope under the exchange domain.
export function orderTypedData(order: OrderMessage, exchange: Exchange): TypedData {
  return {
    domain: exchangeDomain(exchange),
    types: {
      TypedDataSign: [
        { name: "contents", type: "Order" },
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
        { name: "salt", type: "bytes32" },
      ],
      Order: ORDER_FIELDS,
    },
    primaryType: "TypedDataSign",
    message: {
      contents: order,
      name: "DepositWallet",
      version: "1",
      chainId: POLYGON,
      verifyingContract: order.signer,
      salt: ZERO_BYTES32,
    },
  };
}

// signature ++ exchange domain separator ++ hashStruct(order) ++ order type ++ uint16 length.
export function wrapOrderSignature(order: OrderMessage, exchange: Exchange, signature: Hex): Hex {
  const domain = exchangeDomain(exchange);
  const separator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        keccak256(
          stringToHex(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
          ),
        ),
        keccak256(stringToHex(domain.name)),
        keccak256(stringToHex(domain.version)),
        BigInt(domain.chainId),
        domain.verifyingContract,
      ],
    ),
  );
  const contents = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, ...ORDER_FIELDS.map((field) => ({ type: field.type }))],
      [
        keccak256(stringToHex(ORDER_TYPE)),
        order.salt,
        order.maker,
        order.signer,
        order.tokenId,
        order.makerAmount,
        order.takerAmount,
        order.side,
        order.signatureType,
        order.timestamp,
        order.metadata,
        order.builder,
      ],
    ),
  );
  return concatHex([
    signature,
    separator,
    contents,
    stringToHex(ORDER_TYPE),
    numberToHex(ORDER_TYPE.length, { size: 2 }),
  ]);
}

export function orderBody(input: {
  readonly order: OrderMessage;
  readonly signature: Hex;
  readonly apiKey: string;
}): string {
  const { order } = input;
  if (order.salt > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Polymarket order salt must be a safe integer");
  return JSON.stringify({
    deferExec: false,
    postOnly: false,
    order: {
      salt: Number(order.salt),
      maker: order.maker,
      signer: order.signer,
      tokenId: order.tokenId.toString(),
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
      side: order.side === 0 ? "BUY" : "SELL",
      signatureType: order.signatureType,
      timestamp: order.timestamp.toString(),
      expiration: "0",
      metadata: order.metadata,
      builder: order.builder,
      signature: input.signature.toLowerCase(),
    },
    owner: input.apiKey,
    // Fill now what the book can and cancel the rest: an order left resting would fill
    // later, out of sight of the move that placed it.
    orderType: "FAK",
  });
}

export function priceToFill(
  levels: readonly { readonly price: string; readonly size: string }[],
  amount: number,
  side: "buy" | "sell",
): number {
  const sorted = [...levels].sort((left, right) =>
    side === "buy"
      ? Number(left.price) - Number(right.price)
      : Number(right.price) - Number(left.price),
  );
  let total = 0;
  for (const level of sorted) {
    total += side === "buy" ? Number(level.size) * Number(level.price) : Number(level.size);
    if (total >= amount) return Number(level.price);
  }
  throw new Error("The order book is too thin to fill this size right now. Use a smaller amount.");
}
