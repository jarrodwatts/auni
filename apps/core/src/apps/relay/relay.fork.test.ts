import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import { createTestClient, http, numberToHex, pad, publicActions, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { checkedQuote, payInCalls, type PayInRequest } from "../../money/pay-in.ts";
import { answered, deposit, DEPOSITORY } from "./relay.ts";

// What a fork can show of the coin a card buys for another chain's fees (money/fee-coin.ts):
// the one transaction Auni signs for it, as Relay quoted it and core checked it, is taken by
// Relay's real depository on Monad and moves exactly the card's MON there and nothing else.
// That Relay then pays the coin out on the other chain is its own doing, which no fork shows.
//
//   anvil --fork-url https://rpc2.monad.xyz --port 8547
//   AUNI_FORK_RPC=http://127.0.0.1:8547 pnpm --filter @auni/core exec vitest run relay.fork
const FORK = process.env.AUNI_FORK_RPC;

describe.skipIf(!FORK)("Relay's depository on Monad", { timeout: 120_000 }, () => {
  const fork = createTestClient({
    chain: NETWORKS.monad.viem,
    mode: "anvil",
    transport: http(FORK),
    pollingInterval: 100,
  }).extend(publicActions);
  // The address Relay's answer was recorded for, 2026-11-13: 30 MON to ETH on Arbitrum.
  const user: Address = "0x2222222222222222222222222222222222222222";
  const amount = 30n * 10n ** 18n;
  const request: PayInRequest = {
    user,
    recipient: user,
    from: { chain: "monad", token: "native" },
    to: { chain: "arbitrum", token: "native" },
    amount,
  };
  const recorded: unknown = JSON.parse(
    readFileSync(
      new URL("./fixtures/quote-monad-coin-to-arbitrum-coin.json", import.meta.url),
      "utf8",
    ),
  );

  it("takes the deposit core checked: exactly the amount leaves the wallet for it, and it says whose it is", async () => {
    const quote = checkedQuote(
      request,
      { name: "Relay", depository: DEPOSITORY, deposit },
      answered(recorded),
    );
    const [call, ...more] = payInCalls(quote);
    expect(more).toEqual([]);
    await fork.setBalance({ address: user, value: 100n * 10n ** 18n });
    await fork.impersonateAccount({ address: user });
    const [walletBefore, heldBefore] = await Promise.all([
      fork.getBalance({ address: user }),
      fork.getBalance({ address: DEPOSITORY }),
    ]);
    const hash = await fork.sendUnsignedTransaction({
      from: user,
      to: call!.to as Address,
      data: call!.data as `0x${string}`,
      value: BigInt(call!.value!),
    });
    const receipt = await fork.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    const [walletAfter, heldAfter] = await Promise.all([
      fork.getBalance({ address: user }),
      fork.getBalance({ address: DEPOSITORY }),
    ]);
    expect(heldAfter - heldBefore).toBe(amount);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    expect(walletBefore - walletAfter).toBe(amount + gas);
    // The depository's own log says whose deposit it is, how much, and the id the call named
    // for Relay's order; no token moved.
    expect(receipt.logs).toHaveLength(1);
    const [log] = receipt.logs;
    expect(log!.address.toLowerCase()).toBe(DEPOSITORY);
    expect(log!.data.toLowerCase()).toBe(
      `0x${pad(user).slice(2)}${numberToHex(amount, { size: 32 }).slice(2)}${call!.data!.slice(-64)}`,
    );
  });
});
