import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { failureKind } from "../../money/failure.ts";
import { MayHaveSent, type Signer } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import { sendL1 } from "./api.ts";
import { placeOrder, placeStops } from "./orders.ts";
import { problems, sendRefusal } from "./problems.ts";

vi.mock(import("./signing.ts"), async (original) => ({
  ...(await original()),
  signTypedData: async () => ({ r: "0x1", s: "0x2", v: 27 }) as never,
}));

const wallets = {} as Signer;
const order = { type: "order", orders: [], grouping: "na", builder: { b: "0x0", f: 0 } } as const;
const answers = (response: () => Response | Promise<Response>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );

afterEach(() => vi.unstubAllGlobals());

// Its action then stays running rather than failing, which would have the person send it again.
describe("an exchange request that may have reached Hyperliquid", () => {
  it("may have placed an order when no answer came back", async () => {
    answers(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    const timedOut = sendL1(wallets, order);
    await expect(timedOut).rejects.toBeInstanceOf(MayHaveSent);
    await expect(timedOut).rejects.toMatchObject({ sent: { chain: "hyperliquid" } });
    answers(() => new Response("busy", { status: 502 }));
    await expect(sendL1(wallets, order)).rejects.toBeInstanceOf(MayHaveSent);
    answers(() => new Response("<html>", { status: 200 }));
    await expect(sendL1(wallets, order)).rejects.toBeInstanceOf(MayHaveSent);
  });

  it("may have placed an order it took without saying what became of it", async () => {
    answers(() => Response.json({ status: "ok", response: { type: "order", data: {} } }));
    await expect(placeOrder(wallets, order)).rejects.toBeInstanceOf(MayHaveSent);
  });

  it("moved nothing when it only set a move up, or Hyperliquid turned it away", async () => {
    answers(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    await expect(sendL1(wallets, { type: "updateLeverage" })).rejects.not.toBeInstanceOf(
      MayHaveSent,
    );
    // Sent once, so even a rate limit turned it away.
    for (const status of [422, 429]) {
      answers(() => new Response("no", { status }));
      await expect(sendL1(wallets, order)).rejects.toThrow(
        `Hyperliquid rejected the request (HTTP ${status}): no`,
      );
    }
  });
});

// Each refusal Hyperliquid's problems know, answered as its fixture records it.
describe("a request Hyperliquid refuses", () => {
  const recorded = (example: string) =>
    (
      JSON.parse(readFileSync(new URL(example, import.meta.url), "utf8")) as {
        readonly answer: unknown;
      }
    ).answer;

  // Most are answers of Hyperliquid's exchange; a deposit's are a node's, of the send itself.
  const fromExchange = ({ example }: { readonly example: string }) =>
    "status" in (recorded(example) as object);

  it.each(problems.known.filter(fromExchange))(
    "fails the move in the owner's words: $example",
    async (problem) => {
      answers(() => Response.json(recorded(problem.example)));
      const placing = placeOrder(wallets, order);
      await expect(placing).rejects.toBeInstanceOf(Refused);
      await expect(placing).rejects.toThrow(problem.say);
      expect(failureKind(await placing.catch((error: unknown) => error))).toBe(problem.kind);
    },
  );

  it.each(problems.known.filter((problem) => !fromExchange(problem)))(
    "fails a deposit's send in the owner's words: $example",
    (problem) => {
      // As the wallet's send throws it: the node's answer, with the bytes the contract reverted with.
      const thrown = Object.assign(new Error("execution reverted"), recorded(problem.example));
      const failed = sendRefusal(thrown);
      expect(failed).toBeInstanceOf(Refused);
      expect((failed as Error).message).toBe(problem.say);
      expect(failureKind(failed)).toBe(problem.kind);
      // A send that may have gone is never read as a refusal, whatever it wraps.
      const unsure = new MayHaveSent({ chain: "arbitrum" }, "Arbitrum", thrown);
      expect(sendRefusal(unsure)).toBe(unsure);
    },
  );

  it("says what Hyperliquid said of a refusal it doesn't know", async () => {
    answers(() => Response.json({ status: "err", response: "Something new." }));
    const sending = sendL1(wallets, { type: "updateLeverage" });
    await expect(sending).rejects.toThrow("Hyperliquid refused: Something new.");
    await expect(sending).rejects.not.toBeInstanceOf(Refused);
  });

  it("says what became of each order of a request it took, in its own words", async () => {
    // A stop it took answers a bare word and no order id; one it refused answers why.
    const statuses = ["waitingForTrigger", { error: "Invalid TP/SL price." }];
    answers(() => Response.json({ status: "ok", response: { type: "order", data: { statuses } } }));
    const stops = { ...order, orders: [{}, {}] } as never;
    expect(await placeStops(wallets, stops)).toEqual([null, "Invalid TP/SL price."]);
    const rests = [{ resting: { oid: 7 } }];
    answers(() =>
      Response.json({ status: "ok", response: { type: "order", data: { statuses: rests } } }),
    );
    expect(await placeOrder(wallets, order)).toEqual({ oid: 7 });
    const fills = [{ filled: { oid: 8, totalSz: "0.4", avgPx: "100" } }];
    answers(() =>
      Response.json({ status: "ok", response: { type: "order", data: { statuses: fills } } }),
    );
    expect(await placeOrder(wallets, order)).toEqual({ oid: 8, filled: "0.4" });
  });
});
