import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import type { Signer } from "../../money/recipe.ts";
import { sendUserSigned } from "./api.ts";
import { hyperliquidWithdraw } from "./transfers.ts";

const USER = "0x3a01d0be0cf4978b652889c44f34b059be0658db";

// A real withdrawal: signed with `time` 1792736389900, it reached the ledger about four
// minutes later, once the bridge paid it out, named by the Arbitrum payout's transaction.
const PAID = {
  time: 1_792_736_649_002,
  hash: "0xfb4d0712e9ae4a7bca6286970dd7af9773e799940d5c27337e09774264f404db",
  delta: { type: "withdraw", usdc: "122.92", nonce: 1_792_736_389_900_000, fee: "1.0" },
};

// The account as Hyperliquid answers for it: unified and empty, until a test sets what it needs.
let mode: string;
let spot: { total: string; hold: string };
let withdrawable: Record<string, string>;
let ledger: unknown[];

vi.mock(import("./api.ts"), async (original) => ({
  ...(await original()),
  info: vi.fn(async (body: { readonly type: string; readonly dex?: string }) => {
    if (body.type === "userAbstraction") return mode;
    if (body.type === "perpDexs") return [null, { name: "xyz" }];
    if (body.type === "spotClearinghouseState") return { balances: [{ coin: "USDC", ...spot }] };
    if (body.type === "clearinghouseState") {
      const free = withdrawable[body.dex ?? ""] ?? "0.0";
      return { withdrawable: free, marginSummary: { accountValue: free }, assetPositions: [] };
    }
    return ledger;
  }) as never,
  sendUserSigned: vi.fn(async () => {}),
}));
// Auni traded on xyz for them, so that dex's pocket is read along with the main one.
vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  tradedMarkets: vi.fn(async () => ["xyz:TSLA"]),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(async () => USER),
}));

beforeEach(() => {
  mode = "unifiedAccount";
  spot = { total: "0", hold: "0" };
  withdrawable = {};
  ledger = [];
  vi.mocked(sendUserSigned).mockClear();
});

/** Runs a withdrawal whose card showed `shown`: the amount asked for, or what was free then. */
const withdraw = (shown: string, amountUsd?: number) =>
  hyperliquidWithdraw.execute({
    action: { amountUsd: shown } as ActionRow,
    input: { amountUsd },
    wallets: { evmAddress: USER } as Signer,
    recordSent: async () => {},
    posting: (_chain, post) => post(),
  });

/** What was signed, in order: each action's type and the field that says what it does. */
const signed = () =>
  vi
    .mocked(sendUserSigned)
    .mock.calls.map(([, , , action]) => [action.type, action.amount ?? action.abstraction]);

describe("hyperliquidWithdraw", () => {
  it("withdraws all that is free, from the dex pockets that left $10.81 offered and $10.80 refused", async () => {
    mode = "default";
    withdrawable = { "": "4.975", xyz: "5.827" };
    const result = await withdraw("10.80");
    expect(signed()).toEqual([
      ["userSetAbstraction", "unifiedAccount"],
      ["withdraw3", "10.80"],
    ]);
    expect(result.run?.lands).toBe("$9.80 on Arbitrum");
    // Hyperliquid's bridge pays exactly that from its own transaction, so its arrival is known by it.
    expect(result.run?.landsUnits).toBe("9800000");
  });

  it("never withdraws more than the card showed, even when more is free by the tap", async () => {
    spot = { total: "500.00", hold: "0" };
    await withdraw("10.80");
    expect(signed()).toEqual([["withdraw3", "10.80"]]);
  });

  it("withdraws what is left when some of the card's free cash went before the tap", async () => {
    spot = { total: "10.70", hold: "0" };
    await withdraw("10.80");
    expect(signed()).toEqual([["withdraw3", "10.70"]]);
  });

  it("shows all that is free on the card when no amount is given", async () => {
    spot = { total: "10.802", hold: "0" };
    const card = await hyperliquidWithdraw.describe({}, {});
    expect(card.summary).toBe("Bring all free cash ($10.80) back from Hyperliquid to Arbitrum");
    expect(card.amountUsd).toBe("10.80");
  });

  it("signs exactly the amount asked for, and leaves a unified account as it is", async () => {
    spot = { total: "6.625682", hold: "2.110117" };
    await withdraw("4.35", 4.35);
    expect(signed()).toEqual([["withdraw3", "4.35"]]);
  });

  it("refuses more than is free before signing anything, even the switch to unified", async () => {
    mode = "default";
    spot = { total: "10.795", hold: "0" };
    await expect(withdraw("10.80", 10.8)).rejects.toThrow(
      "Hyperliquid has $10.79 free to bring back; open positions hold the rest as margin.",
    );
    expect(sendUserSigned).not.toHaveBeenCalled();
  });

  it("refuses withdrawing all when the fee would leave a dollar or less", async () => {
    spot = { total: "1.50", hold: "0" };
    await expect(hyperliquidWithdraw.describe({}, {})).rejects.toThrow(
      "bringing cash back has to be over $2",
    );
  });
});

const landed = (nonce: string) =>
  hyperliquidWithdraw.landed?.({
    action: { run: { nonce } } as unknown as ActionRow,
    input: { amountUsd: 123.92 },
    evmAddress: USER,
  });

describe("hyperliquidWithdraw.landed", () => {
  it("lands once the ledger lists the withdrawal it signed", async () => {
    ledger = [PAID];
    await expect(landed("1792736389900")).resolves.toEqual({});
  });

  it("waits while the ledger hasn't listed it", async () => {
    await expect(landed("1792736389900")).resolves.toBeNull();
  });

  it("doesn't take another withdrawal's payout", async () => {
    ledger = [PAID];
    await expect(landed("1792736389901")).resolves.toBeNull();
  });
});
