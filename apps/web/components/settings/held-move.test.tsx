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

type Held = NonNullable<DoctorFindingWire["heldMove"]>;
const why = "Auni sent it and never heard back, so it can't tell whether it went through.";
const twenty: Held = { id: "a1", summary: "Withdraw $20 to JAVqaE…6X8n on Solana", why };
const seventy: Held = { id: "a2", summary: "Withdraw $70 to your exchange on Base", why };

const rows = () => [...host.querySelectorAll<HTMLElement>("[data-held]")];
const buttons = (row: HTMLElement) =>
  [...row.querySelectorAll("button")].map((button) => button.textContent);
const tap = (row: HTMLElement, label: string) =>
  act(async () => {
    [...row.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
    await Promise.resolve();
  });
const show = (...moves: Held[]) =>
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        {moves.map((move) => (
          <div key={move.id} data-held>
            <HeldMove move={move} />
          </div>
        ))}
      </QueryClientProvider>,
    ),
  );

// A withdrawal from Settings is in no chat, yet Health told the owner to open its card in
// chat, with nowhere to go (2026-11-25).
it("checks a held move in no chat in place, under the move itself", async () => {
  vi.mocked(heldTap).mockResolvedValue({
    phase: "needs_owner",
    run: { held: "unanswered" },
  } as never);
  show(twenty);
  const [row] = rows();
  expect(row!.textContent).toContain("Withdraw $20 to JAVqaE…6X8n on Solana");
  expect(row!.textContent).toContain(why);
  expect(row!.textContent).toContain("Money shows what you hold");
  expect(row!.textContent).not.toMatch(/chat|portfolio/iu);
  expect(buttons(row!)).toEqual(["Check status", "Dismiss card"]);

  await tap(row!, "Check status");
  expect(heldTap).toHaveBeenCalledWith("a1", "check");
  expect(row!.textContent).toContain("Still no answer.");
});

// With $20 and $70 withdrawals both held, tapping Close it on each turned both rows into the
// same "Auni's work" confirmation, naming neither move (2026-11-25).
it("names each move in its own dismiss confirmation, and dismisses only on a second yes", async () => {
  vi.mocked(heldTap).mockResolvedValue({ phase: "done" } as never);
  show(twenty, seventy);
  const [first, second] = rows();
  await tap(first!, "Dismiss card");
  await tap(second!, "Dismiss card");
  expect(heldTap).not.toHaveBeenCalled();
  expect(first!.textContent).toContain(
    "Dismiss the card to withdraw $20 to JAVqaE…6X8n on Solana? Auni stops checking it. This can't undo or cancel the move, and Auni may never learn whether it went, so check the wallet or exchange it was sent to.",
  );
  expect(second!.textContent).toContain(
    "Dismiss the card to withdraw $70 to your exchange on Base?",
  );
  expect(second!.textContent).not.toContain("$20");
  expect(buttons(first!)).toEqual(["Keep checking", "Dismiss card"]);

  await tap(first!, "Keep checking");
  expect(first!.textContent).not.toContain("Dismiss the card");
  await tap(second!, "Dismiss card");
  expect(heldTap).toHaveBeenCalledTimes(1);
  expect(heldTap).toHaveBeenLastCalledWith("a2", "close");
});
