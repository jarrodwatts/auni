import type { ThreadId } from "@auni/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CoreApiError } from "@/lib/core";

import { startChat } from "./places";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/core", async (actual) => ({
  ...(await actual<typeof import("@/lib/core")>()),
  requestCore: request,
}));

const THREAD = "7d0c0000-0000-4000-8000-000000000001" as ThreadId;
const MESSAGE = "7d0c0000-0000-4000-8000-000000000002";
const made = {
  thread: {
    id: THREAD,
    title: "Why did BTC fall?",
    status: "idle",
    actMode: "ask_first",
    budgetUsd: "0",
    pinnedAt: null,
    modelSelection: null,
    notes: null,
    archivedAt: null,
    moneyLine: null,
    lastActivityAt: "2026-11-25T09:00:00.000Z",
    createdAt: "2026-11-25T09:00:00.000Z",
  },
};
const start = () => startChat({ id: THREAD, messageId: MESSAGE, text: "Why did BTC fall?" });
const bodies = () =>
  request.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => request.mockReset());

// Core makes a chat with its first message in it, once for its ids: so a start whose answer was
// lost is asked for again, and the chat it made is the one that opens.
describe("starting a chat", () => {
  it("asks once more, with the same ids, when the answer was lost", async () => {
    request.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(made);
    expect((await start()).thread.id).toBe(THREAD);
    expect(bodies()).toEqual([
      { id: THREAD, messageId: MESSAGE, text: "Why did BTC fall?" },
      { id: THREAD, messageId: MESSAGE, text: "Why did BTC fall?" },
    ]);
  });

  it("gives up at once when core refused it", async () => {
    const refusal = new CoreApiError({ message: "", status: 400, code: "invalid_body" });
    request.mockRejectedValueOnce(refusal);
    expect(await start().catch((error: unknown) => error)).toBe(refusal);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("says when core kept the message out for the private key it held", async () => {
    request.mockResolvedValue({ ...made, keyKeptOut: true });
    expect((await start()).keyKeptOut).toBe(true);
  });
});
