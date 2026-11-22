import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MAX_BATCH, readChainTool } from "./read-chain.ts";

const turn = { threadId: "thread-1", turnStartedAt: "2026-11-05T00:00:00.000Z" };
afterEach(() => vi.restoreAllMocks());

describe("read_chain", () => {
  const tool = readChainTool(turn);
  const input = z.object(tool.inputSchema);

  it("takes reads only, a batch at a time", () => {
    const call = (method: string) => ({ chainId: 1, calls: [{ method, params: [] }] });
    expect(input.safeParse(call("eth_getBalance")).success).toBe(true);
    for (const method of [
      "eth_sendRawTransaction",
      "eth_getLogs",
      "debug_traceTransaction",
      "alchemy_getAssetTransfers",
    ])
      expect(input.safeParse(call(method)).success).toBe(false);
    const many = Array.from({ length: MAX_BATCH + 1 }, () => ({ method: "eth_chainId" }));
    expect(input.safeParse({ chainId: 1, calls: many }).success).toBe(false);
  });

  it("answers each call with its result or its error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      return Promise.resolve(
        Response.json(
          body.method === "eth_chainId"
            ? { jsonrpc: "2.0", id: body.id, result: "0x1" }
            : {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32000, message: "execution reverted" },
              },
        ),
      );
    });
    const { content, isError } = await tool.handler(
      input.parse({
        chainId: 1,
        calls: [{ method: "eth_chainId" }, { method: "eth_call", params: [{}, "latest"] }],
      }),
    );
    expect(isError).toBeUndefined();
    const answers = JSON.parse((content[0] as { text: string }).text) as unknown[];
    expect(answers[0]).toEqual({ result: "0x1" });
    expect(answers[1]).toEqual({ error: expect.stringContaining("execution reverted") });
  });

  it("refuses a chain it can't read", async () => {
    const { isError } = await tool.handler(
      input.parse({ chainId: 424242, calls: [{ method: "eth_chainId" }] }),
    );
    expect(isError).toBe(true);
  });
});
