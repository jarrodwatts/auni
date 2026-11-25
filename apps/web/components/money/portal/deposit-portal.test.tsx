import type { Me } from "@auni/shared";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { ME_KEY } from "@/components/personalization/use-me";
import { Dialog } from "@/components/ui/dialog";
import { makeWallet } from "@/lib/data/me";
import { depositNetworks } from "@/lib/data/portfolio";

import { DepositPortal, walletMadeQuery } from "./deposit-portal";
import { whatToSend } from "./portal";

const EVM = "0x2222222222222222222222222222222222222222";

vi.mock(import("@/components/money/money-provider"), () => ({
  useMoney: () =>
    ({ depositNetworks: depositNetworks({ evm: EVM, solana: null }), portfolio: null }) as never,
}));
vi.mock(import("@/lib/data/me"), async (original) => ({
  ...(await original()),
  makeWallet: vi.fn(),
}));
// Core hasn't marked where the watch starts yet: it's restarting, or the ask failed.
vi.mock(import("@/components/portfolio/use-portfolio"), async (original) => ({
  ...(await original()),
  useDepositWatch: () => ({ watching: false, landed: [] }),
  useRefreshMoney: () => () => undefined,
}));

// Add money hid the address, its code and Copy until core marked the watch's start, so a mark
// that failed twice left the owner nothing to send to, for good (review of 2026-11-25).
it("shows the address to send to before the watch has started, and says it's getting ready", () => {
  const sheet = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Dialog open>
        <DepositPortal need={null} />
      </Dialog>
    </QueryClientProvider>,
  );
  // The address in full, its code drawn, and Copy ready to press.
  expect(sheet.replaceAll(/<[^>]*>/gu, "")).toContain(EVM);
  expect(sheet).not.toContain("auni-loading-sheen");
  expect(sheet).toContain('aria-label="QR code for this address"');
  const copy = sheet.slice(sheet.lastIndexOf("<button", sheet.indexOf("Copy address")));
  expect(copy.slice(0, copy.indexOf(">"))).not.toContain('disabled=""');
  expect(sheet).toContain("Getting ready to watch for your transfer on Monad");
  expect(sheet).not.toContain("Preparing your wallet address");
});

afterEach(() => vi.useRealTimers());

// A first take whose wallet couldn't be made left none, and Add money had no address to show,
// for good (review of 2026-11-25).
it("makes the wallet there's none of, with one ask however many sheets wait, until it's made", async () => {
  vi.useFakeTimers();
  const me = { wallets: { evm: EVM, solana: null } } as Me;
  vi.mocked(makeWallet)
    .mockRejectedValueOnce(new Error("core is restarting"))
    .mockResolvedValue(me);
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  const sheets = [
    new QueryObserver(client, walletMadeQuery),
    new QueryObserver(client, walletMadeQuery),
  ];
  const stops = sheets.map((sheet) => sheet.subscribe(() => undefined));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(makeWallet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(makeWallet).toHaveBeenCalledTimes(2);
    // The owner as core answered, with the new wallet's address for every screen that shows one.
    expect(client.getQueryData(ME_KEY)).toBe(me);
    // Made: never asked again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(makeWallet).toHaveBeenCalledTimes(2);
  } finally {
    for (const stop of stops) stop();
  }
});

// The watch counts only coins Auni recognises (core's buckets.ts), so "any coin" promised more.
it("names the coins Auni always recognises on each network, and never promises any coin", () => {
  expect(whatToSend("monad")).toBe(
    "Send USDC, USDT or MON on Monad, or another widely traded coin. Other coins still arrive, but may not show here.",
  );
  expect(whatToSend("base")).toMatch(/^Send USDC or ETH on Base, /u);
  expect(whatToSend("solana")).toMatch(/^Send USDC, USDT or SOL on Solana, /u);
  expect(whatToSend("bnb")).toMatch(/^Send BNB on BNB Chain, /u);
});
