import {
  decodeFunctionData,
  domainSeparator,
  getAddress,
  hashTypedData,
  parseAbi,
  slice,
  type TypedDataDefinition,
} from "viem";
import { describe, expect, it } from "vitest";

import { walletsFor } from "../../test/wallets.ts";
import { CONTRACTS, hmacSignature } from "./http.ts";
import { polymarketOrder } from "./order.ts";
import {
  buyFeeCeiling,
  orderBody,
  orderFee,
  orderTypedData,
  priceOnTick,
  priceToFill,
  sizeMarket,
  toMicros,
  wrapOrderSignature,
  type OrderMessage,
} from "./orders.ts";
import { signTyped, walletDocument } from "../../money/typed-data.ts";
import { batchTypedData } from "./relayer.ts";
import {
  conversionSale,
  planFunding,
  spendableCollateral,
  type Funding,
  type Wrappable,
} from "./wallet.ts";

const EXCHANGE = { address: "0xE111180000d2663C0091e4f400237545B87B996B", version: "2" } as const;

/** A fixed order whose ERC-7739 wrapped signature is pinned byte for byte. */
const PINNED_ORDER: OrderMessage = {
  salt: 479_249_096_035n,
  maker: getAddress("0x9ba3fa2f1c3c2b9f27e3f1c7ed1e1e2f3b4c5d6e"),
  signer: getAddress("0x9ba3fa2f1c3c2b9f27e3f1c7ed1e1e2f3b4c5d6e"),
  tokenId:
    55_115_078_421_062_885_512_539_156_303_747_803_058_407_616_201_213_034_911_037_320_915_726_138_659_123n,
  makerAmount: 5_000_000n,
  takerAmount: 10_000_000n,
  side: 0,
  signatureType: 3,
  timestamp: 1_785_390_600_000n,
  metadata: `0x${"00".repeat(32)}`,
  builder: `0x${"11".repeat(32)}`,
};

describe("deposit wallet order signing", () => {
  it("reproduces the pinned ERC-7739 wrapped signature byte for byte", async () => {
    const wallets = walletsFor(`0x${"11".repeat(32)}`);
    const inner = await signTyped(wallets, orderTypedData(PINNED_ORDER, EXCHANGE));
    expect(wrapOrderSignature(PINNED_ORDER, EXCHANGE, inner)).toBe(
      "0x88e659ff62ffcefc100758e7c41ed2730a828b914c9992c338908169652a749843655280ceba9295b22a2534984a855f52ec7e9c33e0283ba77183f30e95d8991b3264e159346253e26a64e00b69032db0e7d32f94628de3e6eecb50304d7af3d2001a8d8587c5a28daa7da568151081fb471affff55ed3bc0d939b3626d7304284f726465722875696e743235362073616c742c61646472657373206d616b65722c61646472657373207369676e65722c75696e7432353620746f6b656e49642c75696e74323536206d616b6572416d6f756e742c75696e743235362074616b6572416d6f756e742c75696e743820736964652c75696e7438207369676e6174757265547970652c75696e743235362074696d657374616d702c62797465733332206d657461646174612c62797465733332206275696c6465722900ba",
    );
  });

  it("refuses a signature that does not recover to the owner", async () => {
    const wallets = walletsFor(
      `0x${"11".repeat(32)}`,
      "0x1111111111111111111111111111111111111111",
    );
    await expect(signTyped(wallets, orderTypedData(PINNED_ORDER, EXCHANGE))).rejects.toThrow(
      "did not recover",
    );
  });

  it("hands the wallet JSON-safe typed data with lowercase addresses", () => {
    const document = walletDocument(orderTypedData(PINNED_ORDER, EXCHANGE));
    const contents = document.message.contents as Record<string, unknown>;
    expect(document.domain).toEqual({
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: 137,
      verifyingContract: EXCHANGE.address.toLowerCase(),
    });
    expect(Object.keys(document.types)[0]).toBe("EIP712Domain");
    expect(contents.salt).toBe("479249096035");
    expect(contents.maker).toBe("0x9ba3fa2f1c3c2b9f27e3f1c7ed1e1e2f3b4c5d6e");
    expect(() => JSON.stringify(document)).not.toThrow();
  });

  it("signs a Protocol V2 order under ExchangeV3's version 3 domain, in the signature and its wrapper", async () => {
    const exchange = { address: CONTRACTS.exchangeV3, version: "3" } as const;
    const domain = {
      name: "Polymarket CTF Exchange",
      version: "3",
      chainId: 137,
      verifyingContract: CONTRACTS.exchangeV3,
    } as const;
    const typed = orderTypedData(PINNED_ORDER, exchange);
    expect(typed.domain).toEqual(domain);
    const wallets = walletsFor(`0x${"11".repeat(32)}`);
    const wrapped = wrapOrderSignature(PINNED_ORDER, exchange, await signTyped(wallets, typed));
    // The separator sits right after the 65-byte signature.
    expect(slice(wrapped, 65, 97)).toBe(domainSeparator({ domain }));
  });
});

describe("POST /order body", () => {
  it("sends the salt as a JSON number and every other integer as text", () => {
    const body = JSON.parse(
      orderBody({
        order: { ...PINNED_ORDER, salt: 42n },
        signature: "0xABCD",
        apiKey: "key-1",
      }),
    );
    expect(body).toEqual({
      deferExec: false,
      postOnly: false,
      order: {
        salt: 42,
        maker: PINNED_ORDER.maker,
        signer: PINNED_ORDER.signer,
        tokenId: PINNED_ORDER.tokenId.toString(),
        makerAmount: "5000000",
        takerAmount: "10000000",
        side: "BUY",
        signatureType: 3,
        timestamp: "1785390600000",
        expiration: "0",
        metadata: `0x${"00".repeat(32)}`,
        builder: `0x${"11".repeat(32)}`,
        signature: "0xabcd",
      },
      owner: "key-1",
      orderType: "FAK",
    });
    expect(() =>
      orderBody({
        order: { ...PINNED_ORDER, salt: 2n ** 60n },
        signature: "0x00",
        apiKey: "k",
      }),
    ).toThrow("safe integer");
  });
});

describe("sizing", () => {
  it("builds market amounts the way the official client does", () => {
    expect(sizeMarket("buy", 70_000n, 10_000n, toMicros(5.009))).toEqual({
      makerAmount: 5_000_000n,
      takerAmount: 71_428_500n,
    });
    expect(sizeMarket("buy", 72_000n, 1_000n, toMicros(5))).toEqual({
      makerAmount: 5_000_000n,
      takerAmount: 69_444_440n,
    });
    expect(sizeMarket("sell", 330_000n, 10_000n, 10_005_000n)).toEqual({
      makerAmount: 10_000_000n,
      takerAmount: 3_300_000n,
    });
  });

  it("rounds off-tick prices in the owner's favour and refuses prices off the book", () => {
    expect(priceOnTick(74_900n, 10_000n, "buy")).toBe(70_000n);
    expect(priceOnTick(74_900n, 10_000n, "sell")).toBe(80_000n);
    expect(() => priceOnTick(995_000n, 10_000n, "sell")).toThrow("between 0.01 and 0.99");
  });

  it("walks the book to the price a market order reaches", () => {
    const asks = [
      { price: "0.09", size: "100" },
      { price: "0.07", size: "10" },
      { price: "0.08", size: "20" },
    ];
    expect(priceToFill(asks, 0.5, "buy")).toBe(0.07);
    expect(priceToFill(asks, 2, "buy")).toBe(0.08);
    expect(() => priceToFill(asks, 100, "buy")).toThrow("too thin");
  });

  it("bounds a buy's fees by cash, not by the shares a cheap fill could return", () => {
    // $1 at 7c on fd {r: 0.07, e: 1}: at most $0.07 to Polymarket.
    expect(buyFeeCeiling(1_000_000n, 14_280_000n, { rateMicros: 70_000n, exponent: 1n })).toBe(
      70_000n,
    );
    expect(buyFeeCeiling(1_000_000n, 2_000_000n, { rateMicros: 10_000n, exponent: 0n })).toBe(
      20_000n,
    );
  });

  it("records the fee a fill paid at its price, never above the ceiling it was funded with", () => {
    const fees = { rateMicros: 70_000n, exponent: 1n };
    // 2 shares for $1 at 50c: 0.07 * 0.25 a share to Polymarket.
    expect(orderFee(1_000_000n, 2_000_000n, fees)).toBe(35_000n);
    expect(orderFee(1_000_000n, 14_280_000n, fees)).toBeLessThanOrEqual(
      buyFeeCeiling(1_000_000n, 14_280_000n, fees),
    );
    expect(orderFee(0n, 0n, fees)).toBe(0n);
  });
});

describe("relayer", () => {
  it("hashes a deposit wallet batch to the pinned digest", () => {
    const typedData = batchTypedData(
      "0x2222222222222222222222222222222222222222",
      7n,
      1_785_000_600n,
      [
        { target: "0x4444444444444444444444444444444444444444", data: "0xdeadbeef" },
        { target: "0x5555555555555555555555555555555555555555", data: "0xfeedface", value: 1n },
      ],
    );
    expect(hashTypedData(typedData as TypedDataDefinition)).toBe(
      "0xe34c0479b738d265bfa3a184f15756d6e92b6f9935c584d74baf898664a21e59",
    );
  });

  it("signs builder requests with the pinned HMAC vectors", () => {
    const secret = "cmV2aWV3ZWQtYnVpbGRlci1zZWNyZXQ=";
    expect(
      hmacSignature(secret, `1785000000POST/submit${JSON.stringify({ type: "WALLET-CREATE" })}`),
    ).toBe("usKvkKjY-9QiQ8qqouvgGZJd36ZmQvhrojeNU-BvXys=");
    expect(hmacSignature(secret, "1785000000GET/deployed")).toBe(
      "BRWcQDmTdUITHonAk8PpgL-rMsLKynDEVBSqgxjyHp4=",
    );
  });
});

describe("funding a buy", () => {
  const WALLET = getAddress("0x2222222222222222222222222222222222222222");
  const onrampAbi = parseAbi(["function wrap(address asset, address to, uint256 amount)"]);

  function asset(
    which: "usdce" | "usdc",
    held: { readonly inWallet?: bigint; readonly inOwner?: bigint; readonly paused?: boolean },
  ): Wrappable {
    return {
      asset: CONTRACTS[which],
      paused: held.paused ?? false,
      inWallet: held.inWallet ?? 0n,
      inOwner: held.inOwner ?? 0n,
    };
  }

  /** The asset and amount the batch's wrap call hands the onramp. */
  function wrapped(funding: Funding): readonly unknown[] {
    const wrap = funding.calls.find((call) => call.target === CONTRACTS.collateralOnramp);
    if (!wrap) throw new Error("No wrap call.");
    return decodeFunctionData({ abi: onrampAbi, data: wrap.data }).args;
  }

  it("needs nothing when the wallet's pUSD already covers the order", () => {
    expect(planFunding(WALLET, 2_090_000n, 2_090_000n, [])).toEqual({ calls: [] });
  });

  it("wraps native USDC pulled from the owner while the onramp takes it", () => {
    const funding = planFunding(WALLET, 2_090_000n, 1_000_000n, [
      asset("usdce", { inOwner: 4_641n }),
      asset("usdc", { inOwner: 5_991_393n }),
    ]);
    expect(funding.convert).toBeUndefined();
    expect(funding.pull).toEqual({ asset: CONTRACTS.usdc, amount: 1_090_000n });
    expect(wrapped(funding)).toEqual([CONTRACTS.usdc, WALLET, 1_090_000n]);
  });

  it("swaps native USDC into the USDC.e still missing while native USDC is paused", () => {
    // A real wallet when it failed: 1 pUSD, dust of USDC.e, about $6 of native USDC.
    const assets = [
      asset("usdce", { inOwner: 4_641n }),
      asset("usdc", { inOwner: 5_991_393n, paused: true }),
    ];
    expect(planFunding(WALLET, 2_090_000n, 1_000_000n, assets)).toEqual({
      calls: [],
      convert: 1_085_359n,
    });
  });

  it("won't convert without the margin the swap sells over what it delivers", () => {
    // 1.085359 USDC.e is missing; the swap sells 0.5% more, which 1.086 native USDC can't cover.
    const tight = [
      asset("usdce", { inOwner: 4_641n }),
      asset("usdc", { inOwner: 1_086_000n, paused: true }),
    ];
    expect(() => planFunding(WALLET, 2_090_000n, 1_000_000n, tight)).toThrow(
      "More USDC has to reach Polygon first.",
    );
  });

  it("then wraps the swapped USDC.e, with any surplus the swap delivered", () => {
    const funding = planFunding(WALLET, 2_093_000n, 1_000_000n, [
      asset("usdce", { inWallet: 4_641n, inOwner: 1_088_359n }),
      asset("usdc", { inOwner: 4_900_000n, paused: true }),
    ]);
    expect(funding.pull).toEqual({ asset: CONTRACTS.usdce, amount: 1_088_359n });
    expect(wrapped(funding)).toEqual([CONTRACTS.usdce, WALLET, 1_093_000n]);
  });

  it("says plainly what's there when Polygon holds too little", () => {
    const short = [
      asset("usdce", { inOwner: 4_641n }),
      asset("usdc", { inOwner: 500_000n, paused: true }),
    ];
    expect(() => planFunding(WALLET, 2_090_000n, 1_000_000n, short)).toThrow(
      "On Polygon there is 1 pUSD in the Polymarket wallet, 0.004641 USDC.e, 0.5 native USDC (Polymarket is not accepting it right now). More USDC has to reach Polygon first.",
    );
    const closed = [
      asset("usdce", { inOwner: 9_000_000n, paused: true }),
      asset("usdc", { inOwner: 9_000_000n, paused: true }),
    ];
    expect(() => planFunding(WALLET, 2_090_000n, 0n, closed)).toThrow(
      "Polymarket is not accepting deposits right now",
    );
  });

  it("counts as Polygon cash only what the onramp takes, with USDC.e a failed setup left the owner", () => {
    const assets = [
      asset("usdce", { inWallet: 100n, inOwner: 1_088_359n }),
      asset("usdc", { inWallet: 5_000n, inOwner: 5_991_393n, paused: true }),
    ];
    expect(spendableCollateral(1_000_000n, assets)).toBe(2_088_459n);
    // The owner's native USDC is wallet cash already, so it isn't counted again.
    expect(
      spendableCollateral(0n, [asset("usdc", { inWallet: 5_000n, inOwner: 5_991_393n })]),
    ).toBe(5_000n);
    expect(spendableCollateral(0n, [asset("usdce", { inOwner: 7n, paused: true })])).toBe(0n);
  });

  it("sells 0.5% over the USDC.e needed, rounded up, or all the owner holds", () => {
    // $2.17 needed: 0.5% is over a cent.
    expect(conversionSale(2_170_718n, 5_991_393n)).toBe(2_181_572n);
    expect(conversionSale(2_000_000n, 2_001_000n)).toBe(2_001_000n);
  });

  it("sells at least a cent over, as a few cents' swap costs its route more than 0.5%", () => {
    // A real top-up: 0.5% would sell 0.054876, which was quoted to guarantee only 0.05455.
    expect(conversionSale(54_602n, 5_991_393n)).toBe(64_602n);
    expect(conversionSale(1_085_359n, 5_991_393n)).toBe(1_095_359n);
  });

  it("draws a buy from Polygon cash, and a sale from nothing", () => {
    const market = { market: "will-it-rain", outcome: "Yes" };
    expect(
      polymarketOrder.fundedFrom?.({
        input: { ...market, side: "buy", amountUsd: 2 },
        details: {},
      }),
    ).toBe("polygon");
    expect(polymarketOrder.fundedFrom?.({ input: { ...market, side: "sell" }, details: {} })).toBe(
      null,
    );
  });
});
