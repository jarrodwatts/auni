import { NETWORK_KEYS } from "@auni/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Account, App } from "./contract.ts";
import {
  accountOf,
  accountOwning,
  accountToken,
  accounts,
  chainCash,
  isMargined,
  ledgerAt,
  savingsTokens,
  standIn,
} from "./registry.ts";

// The registry's questions about accounts, asked of one account of each way money is kept: in
// a ledger of the app's own, in contracts on a chain, and in the owner's wallet (savings
// counted as cash, and a vault's shares it prices itself). And of one app that calls itself
// by a network's name, which must never be taken for a place that isn't a chain.

const SAVED = "0x00000000000000000000000000000000000000a1";
const SHARES = "0x00000000000000000000000000000000000000b1";
const COLLATERAL = "0x00000000000000000000000000000000000000c1";

const base = {
  face: async () => ({ name: "", detail: "", logoUrl: null }),
  moneyIn: "By hand.",
  moneyOut: "By hand.",
} satisfies Partial<Account>;

const ledger: Account = {
  ...base,
  kept: { ledger: async () => [] },
  margined: true,
  cash: { kind: "ledger", free: async () => 0n, outFeeUsd: 1 },
};
const onChain: Account = {
  ...base,
  kept: {
    chains: ["polygon"],
    read: async () => [],
    // Wider than its chains on purpose: the registry asks it only of a key on one of them.
    owns: (key) => /^\d+$/u.test(key.instrument),
  },
  cash: { kind: "chain", chain: "polygon", tokens: [COLLATERAL], free: async () => 0n },
};
const savings: Account = {
  ...base,
  kept: { wallet: [{ chain: "base", instrument: SAVED, symbol: "sUSD" }] },
  cash: {
    kind: "savings",
    token: (chain) => (chain === "base" ? { pool: SAVED, token: SAVED, symbol: "sUSD" } : null),
  },
};
const vault: Account = {
  ...base,
  kept: { wallet: [{ chain: "base", instrument: SHARES, symbol: "vSHARE" }] },
  prices: { live: async () => 1.03, history: async () => [] },
};

const app = (id: string, account?: Account): App => ({
  about: { id, name: id },
  ...(account ? { account } : {}),
});

beforeAll(() =>
  standIn(() => [
    app("led", ledger),
    app("onchain", onChain),
    app("sav", savings),
    app("vault", vault),
    app("plain"),
    // An app that names itself after a network and claims a ledger: apps.test.ts fails a
    // real one, and the registry still never takes a network for a ledger.
    app("base", ledger),
  ]),
);
afterAll(() => standIn((real) => real));

describe("accounts", () => {
  it("are every app's that has one, found by its app's id", () => {
    expect(accounts().map(({ about }) => about.id)).toEqual([
      "led",
      "onchain",
      "sav",
      "vault",
      "base",
    ]);
    expect(accountOf("vault")?.account).toBe(vault);
    expect(accountOf("plain")).toBeUndefined();
    expect(accountOf("nobody")).toBeUndefined();
  });

  it("own the holdings each says are its own, and no other", () => {
    expect(accountOwning({ chain: "led", instrument: "BTC" })?.about.id).toBe("led");
    expect(accountOwning({ chain: "polygon", instrument: "777" })?.about.id).toBe("onchain");
    expect(accountOwning({ chain: "base", instrument: SAVED.toUpperCase() })?.about.id).toBe("sav");
    expect(accountOwning({ chain: "base", instrument: SHARES })?.about.id).toBe("vault");
    expect(accountOwning({ chain: "polygon", instrument: COLLATERAL })).toBeUndefined();
    expect(accountOwning({ chain: "solana", instrument: "native" })).toBeUndefined();
  });

  // Each way of keeping owns in its own way, and core holds each to its place: a ledger owns
  // only what is filed under its app's id, contracts only on their chains, a wallet only its list.
  it("own nothing outside where each is kept, whatever an account says", () => {
    // The account on Polygon says yes to any number, and is never asked of another chain.
    expect(accountOwning({ chain: "base", instrument: "777" })).toBeUndefined();
    expect(accountOwning({ chain: "led", instrument: "777" })?.about.id).toBe("led");
    // A ledger named after a network owns nothing on it.
    expect(accountOwning({ chain: "base", instrument: "BTC" })).toBeUndefined();
    expect(accountOwning({ chain: "monad", instrument: SHARES })).toBeUndefined();
  });

  it("name the tokens kept in the wallet, by the symbol each account gives", () => {
    expect(accountToken({ chain: "base", instrument: SHARES.toUpperCase() })?.symbol).toBe(
      "vSHARE",
    );
    expect(accountToken({ chain: "base", instrument: SAVED })?.symbol).toBe("sUSD");
    expect(accountToken({ chain: "polygon", instrument: "777" })).toBeUndefined();
    expect(accountToken({ chain: "led", instrument: "BTC" })).toBeUndefined();
  });
});

describe("ledgerAt", () => {
  it("finds only an account kept in a ledger of the app's own, by the app's id", () => {
    expect(ledgerAt("led")).toMatchObject({ about: { id: "led" }, account: ledger });
    expect(ledgerAt("led")!.ledger).toBe((ledger.kept as { readonly ledger: unknown }).ledger);
    // Kept on a chain or in the wallet, an account is not a place of its own.
    for (const id of ["onchain", "sav", "vault", "plain", "nobody", "wallet", "auni"])
      expect(ledgerAt(id), id).toBeUndefined();
  });

  // A send to a ledger has no receipt and reconciles as confirmed. A network taken for one
  // would have a reverted send on it recorded as done.
  it("never finds a network, even one an app names itself after", () => {
    for (const chain of NETWORK_KEYS) expect(ledgerAt(chain), chain).toBeUndefined();
    expect(accountOf("base")?.account.kept).toHaveProperty("ledger");
  });
});

describe("isMargined", () => {
  it("is true only of a holding a leveraged account owns", () => {
    expect(isMargined({ chain: "led", instrument: "BTC" })).toBe(true);
    expect(isMargined({ chain: "polygon", instrument: "777" })).toBe(false);
    expect(isMargined({ chain: "base", instrument: SHARES })).toBe(false);
    expect(isMargined({ chain: "arbitrum", instrument: "native" })).toBe(false);
  });
});

describe("the cash an account keeps", () => {
  it("is listed as savings where it is a wallet token counted as cash, a chain at a time", () => {
    expect(savingsTokens("base")).toEqual([
      { pool: SAVED, token: SAVED, symbol: "sUSD", about: { id: "sav", name: "sav" } },
    ]);
    expect(savingsTokens("monad")).toEqual([]);
  });

  it("is listed as a chain's cash where it is dollar tokens a buy there spends", () => {
    expect(chainCash().map(({ about, cash }) => [about.id, cash.chain, cash.tokens])).toEqual([
      ["onchain", "polygon", [COLLATERAL]],
    ]);
  });
});
