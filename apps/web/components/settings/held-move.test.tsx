// @vitest-environment happy-dom
import type { DoctorFindingWire } from "@auni/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { heldTap } from "@/lib/data/actions";

import { HeldMove } from "./held-move";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("settings=health"),
}));
vi.mock("@/lib/data/actions", () => ({ heldTap: vi.fn(), readQuote: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const withdrawal: DoctorFindingWire = {
  check: "runner",
  status: "fix",
  says: "Withdraw $20 to JAVqaE…6X8n on Solana needs checking. Auni sent it and never heard back, so it can't tell whether it went through.",
  repair: null,
  chats: [],
  heldMove: "a1",
};

const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent);
const tap = (label: string) =>
  act(async () => {
    [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
    await Promise.resolve();
  });

// A withdrawal from Settings is in no chat, yet Health told the owner to open its card in
// chat, with nowhere to go (2026-11-25).
it("checks a held move in no chat in place, and closes it only on a second yes", async () => {
  vi.mocked(heldTap).mockResolvedValue({ phase: "needs_owner" } as never);
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <HeldMove finding={withdrawal} />
      </QueryClientProvider>,
    ),
  );
  expect(host.textContent).toContain("Withdraw $20 to JAVqaE…6X8n on Solana needs checking.");
  expect(host.textContent).toContain("Auni won't send it again");
  expect(host.textContent).not.toMatch(/chat/u);
  expect(buttons()).toEqual(["Check status", "Close it"]);

  await tap("Check status");
  expect(heldTap).toHaveBeenCalledWith("a1", "check");
  expect(host.textContent).toContain("Still no answer. Auni keeps checking by itself.");

  await tap("Close it");
  expect(heldTap).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Close it without a record?");
  await tap("Close it");
  expect(heldTap).toHaveBeenLastCalledWith("a1", "close");
});
