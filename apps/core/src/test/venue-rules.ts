import { EVM_CASH_KEYS, NETWORKS, type AppAbout } from "@auni/shared";
import { expect } from "vitest";

import type { Account, App } from "../apps/contract.ts";
import { coinName } from "../money/coins.ts";
import { fillIdentity, type FillKey } from "../money/fill-key.ts";

const OWNER = `0x${"1".repeat(40)}` as const;

const recorded = (about: AppAbout) =>
  Object.entries(about.tools ?? {}).flatMap(([name, tool]) =>
    tool.kind === "recorded" ? [name] : [],
  );

/**
 * What core asks of each app beyond its types, checked of every real app (apps.test.ts),
 * every skeleton `pnpm scaffold` writes and the second venues in second-venues/: its recipes are
 * filed under it and name no lane of their own, a bridge offers its recipe as a tool, and its
 * account, if it has one, holds together.
 */
export function expectKindsKept(app: App): void {
  const { about, moves, bridge, account } = app;
  for (const recipe of moves ?? []) {
    expect(recipe.venue, recipe.tool).toBe(about.id);
    // An app's moves share a lane only by its oneAtATime, said once, so none can be left out.
    expect(recipe.lane, `${recipe.tool} names a lane of its own`).toBeUndefined();
    // Nor a mark: its card wears its app's.
    expect(recipe.mark, `${recipe.tool} names a mark of Auni's`).toBeUndefined();
  }
  if (bridge) expect(moves, about.id).toContain(bridge.recipe);
  if (account) expectAccountHolds(app, account);
}

/**
 * An account holds together: a payout or a statement is recorded under a tool its meta lists, a
 * move it names for money in or out is one of the app's own, and how its cash counts agrees
 * with where its money is kept.
 */
function expectAccountHolds({ about, moves }: App, account: Account): void {
  if (account.payouts) expect(recorded(about), about.id).toContain(account.payouts.tool);
  if (account.statement) expect(recorded(about), about.id).toContain(account.statement(OWNER).tool);
  for (const way of [account.moneyIn, account.moneyOut])
    if (typeof way === "string") expect(way.length, `${about.id}: ${way}`).toBeGreaterThan(10);
    else expect(moves, `${about.id} ${way.tool}`).toContain(way);

  const { kept, cash } = account;
  const ledger = "ledger" in kept;
  // Only a ledger keeps cash in a ledger, the one kind of cash that is on no chain.
  expect(cash?.kind === "ledger" && !ledger, `${about.id} keeps ledger cash on a chain`).toBe(
    false,
  );
  if (cash?.kind === "chain")
    expect(kept, `${about.id} keeps cash on ${cash.chain}`).toMatchObject({
      chains: expect.arrayContaining([cash.chain]),
    });
  if (cash?.kind === "savings") {
    // Savings are a wallet token of the account's, on every chain it has one.
    expect(kept, about.id).toHaveProperty("wallet");
    const listed = "wallet" in kept ? kept.wallet.map(fillIdentity) : [];
    for (const chain of [...EVM_CASH_KEYS, "solana", "nowhere"]) {
      const token = cash.token(chain)?.token;
      if (token)
        expect(listed, `${about.id} ${chain}`).toContain(
          fillIdentity({ chain, instrument: token }),
        );
    }
  }
}

/**
 * No account owns more than its own, checked of every installed app together (apps.test.ts, and
 * the second venues beside them). A token an account keeps in the wallet is never a network's
 * coin or its USDC or USDT, and no two accounts list one token. An account that owns an open set
 * on its chains (see Account.kept) says no to everything there that is someone else's: the
 * chain's coin and dollar tokens, the dollar tokens any account counts as cash, every token
 * another account lists, and a plain token nobody lists. So an account that claimed a whole
 * chain would have every token on it named and priced by its app, and fails here.
 */
export function expectOwnOnlyTheirOwn(apps: readonly App[]): void {
  const accounts = apps.flatMap(({ about, account }) => (account ? [{ about, account }] : []));
  const listed = accounts.flatMap(({ about, account: { kept } }) =>
    "wallet" in kept ? kept.wallet.map((token) => ({ about, token })) : [],
  );
  for (const { about, token } of listed) {
    expect(Object.keys(NETWORKS), `${about.id} ${token.symbol}`).toContain(token.chain);
    expect(coinName(token), `${about.id} lists ${fillIdentity(token)}`).toBeNull();
    expect(token.symbol.trim(), `${about.id} ${fillIdentity(token)}`).not.toBe("");
  }
  const identities = listed.map(({ token }) => fillIdentity(token));
  expect(new Set(identities).size, identities.join(" ")).toBe(identities.length);

  for (const { about, account } of accounts) {
    const { kept } = account;
    if (!("chains" in kept)) continue;
    for (const chain of kept.chains) {
      const { usdc, usdt } = NETWORKS[chain];
      const others: FillKey[] = [
        { chain, instrument: "native" },
        ...[usdc, usdt].flatMap((instrument) => (instrument ? [{ chain, instrument }] : [])),
        ...accounts.flatMap(({ account: { cash } }) =>
          cash?.kind === "chain" && cash.chain === chain
            ? cash.tokens.map((instrument) => ({ chain, instrument }))
            : [],
        ),
        ...listed.flatMap(({ token }) => (token.chain === chain ? [token] : [])),
        { chain, instrument: "0x00000000000000000000000000000000000a11ce" },
      ];
      for (const key of others)
        expect(kept.owns(key), `${about.id} owns ${fillIdentity(key)}`).toBe(false);
    }
  }
}
