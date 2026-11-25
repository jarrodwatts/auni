import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { Dialog } from "@/components/ui/dialog";
import { depositNetworks } from "@/lib/data/portfolio";

import { DepositPortal } from "./deposit-portal";

const EVM = "0x2222222222222222222222222222222222222222";

vi.mock(import("@/components/money/money-provider"), () => ({
  useMoney: () =>
    ({ depositNetworks: depositNetworks({ evm: EVM, solana: null }), portfolio: null }) as never,
}));
// Core hasn't marked where the watch starts yet: it's restarting, or the ask failed.
vi.mock(import("@/components/portfolio/use-portfolio"), () => ({
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
