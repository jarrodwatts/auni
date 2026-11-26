import type { ThreadId } from "@auni/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CoreApiError } from "@/lib/core";

import { startFailure } from "@/components/app/thread-failure";

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

  it("gives up at once when core refused it, and says it didn't start", async () => {
    const refusal = new CoreApiError({ message: "", status: 400, code: "invalid_body" });
    request.mockRejectedValueOnce(refusal);
    const failure = await start().catch((error: unknown) => error);
    expect(failure).toBe(refusal);
    expect(request).toHaveBeenCalledTimes(1);
    expect(startFailure(failure)).toBe(
      "Auni couldn't start this chat. Your words are back in the box to send again.",
    );
  });

  // Review, 2026-11-25 (round 5): both answers lost said the chat couldn't start, while core had
  // made it and was answering in it.
  it("says it couldn't confirm the start when both answers were lost", async () => {
    request
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new CoreApiError({ message: "", status: 502 }));
    const failure = await start().catch((error: unknown) => error);
    expect(request).toHaveBeenCalledTimes(2);
    expect(startFailure(failure)).toBe(
      "Auni couldn't confirm this chat started. Your words are back in the box: send them again to open it.",
    );
  });

  it("says when core kept the message out for the private key it held", async () => {
    request.mockResolvedValue({ ...made, keyKeptOut: true });
    expect((await start()).keyKeptOut).toBe(true);
  });
});
