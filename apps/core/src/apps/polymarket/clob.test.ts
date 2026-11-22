import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";

import { failureKind } from "../../money/failure.ts";
import { MayHaveSent } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import { postOrder } from "./clob.ts";
import { problems } from "./problems.ts";

const creds = { address: "0x1", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" };
const answers = (response: () => Response | Promise<Response>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );

afterEach(() => vi.unstubAllGlobals());

// An order that may be on the book keeps its action running, never failed and sent again.
describe("postOrder", () => {
  it("may have placed an order Polymarket didn't answer", async () => {
    answers(() => Promise.reject(new TypeError("fetch failed")));
    await expect(postOrder(creds, "{}")).rejects.toBeInstanceOf(MayHaveSent);
    answers(() => new Response("busy", { status: 503 }));
    await expect(postOrder(creds, "{}")).rejects.toMatchObject({ sent: { chain: "polygon" } });
    // A server error that says nothing of the order is no answer either.
    answers(() => new Response('{"error":"could not insert order"}', { status: 500 }));
    await expect(postOrder(creds, "{}")).rejects.toBeInstanceOf(MayHaveSent);
  });

  it("placed nothing when a paused exchange says so, though it answers as a server error", async () => {
    const paused = (error: string) =>
      answers(() => new Response(JSON.stringify({ error }), { status: 503 }));
    paused("Trading is currently disabled. Check polymarket.com for updates");
    await expect(postOrder(creds, "{}")).rejects.toThrow("has paused its exchange");
    paused("post-only mode: only post-only orders and cancels are allowed");
    const posting = postOrder(creds, "{}");
    await expect(posting).rejects.toThrow("is taking no orders like this one for now");
    await expect(posting).rejects.not.toBeInstanceOf(MayHaveSent);
  });

  it("placed nothing when Polymarket turned the order away, a rate limit included", async () => {
    answers(() => new Response('{"error":"slow down"}', { status: 429 }));
    await expect(postOrder(creds, "{}")).rejects.not.toBeInstanceOf(MayHaveSent);
  });
});

// Each refusal of its order book that Polymarket's problems know, answered as its fixture records it.
describe("an order Polymarket refuses", () => {
  const recorded = problems.known.flatMap((problem) => {
    const { answer } = JSON.parse(
      readFileSync(new URL(problem.example, import.meta.url), "utf8"),
    ) as { readonly answer: { readonly service: string; status: number; body: unknown } };
    return answer.service === "Polymarket CLOB" ? [{ ...problem, answer }] : [];
  });

  it.each(recorded)("fails the move in the owner's words: $example", async (problem) => {
    const { status, body } = problem.answer;
    answers(() => new Response(body === "" ? "" : JSON.stringify(body), { status }));
    const posting = postOrder(creds, "{}");
    await expect(posting).rejects.toBeInstanceOf(Refused);
    await expect(posting).rejects.toThrow(problem.say);
    expect(failureKind(await posting.catch((error: unknown) => error))).toBe(problem.kind);
  });

  it("reads the reason an order it answered gives for not being placed", async () => {
    answers(() => Response.json({ success: false, errorMsg: "not enough balance / allowance" }));
    await expect(postOrder(creds, "{}")).rejects.toThrow("hadn't caught up");
  });

  it("says what Polymarket said of a refusal it doesn't know, and who answered", async () => {
    answers(() => new Response('{"error":"the market is closed"}', { status: 400 }));
    const posting = postOrder(creds, "{}");
    await expect(posting).rejects.toThrow(
      "Polymarket refused: the market is closed (Polymarket CLOB, HTTP 400)",
    );
    await expect(posting).rejects.not.toBeInstanceOf(Refused);
  });
});
