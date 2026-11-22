import { describe, expect, it, vi } from "vitest";

import { runSteps, type Step } from "./browser-wallet";

const step = (id: Step["id"]): Step => ({
  id,
  description: id,
  chainId: 8453,
  to: "0x4cd00e387622c35bddb9b4c962c136462338bc31",
  data: "0x",
});

describe("runSteps", () => {
  it("sends each step in order, each once the one before landed", async () => {
    const order: string[] = [];
    await runSteps(
      [step("approve"), step("deposit")],
      {
        send: async ({ id }) => {
          order.push(`send ${id}`);
          return `0x${id}`;
        },
        landed: async (hash) => {
          order.push(`landed ${hash}`);
          return true;
        },
      },
      (index) => order.push(`step ${index}`),
    );
    expect(order).toEqual([
      "step 0",
      "send approve",
      "landed 0xapprove",
      "step 1",
      "send deposit",
      "landed 0xdeposit",
    ]);
  });

  it("sends nothing more once the owner turns a step down, or one fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("User rejected the request.");
    });
    await expect(
      runSteps([step("approve"), step("deposit")], { send, landed: async () => true }, () => {}),
    ).rejects.toThrow(/rejected/u);
    expect(send).toHaveBeenCalledTimes(1);

    const sent = vi.fn(async () => "0x1" as const);
    await expect(
      runSteps(
        [step("approve"), step("deposit")],
        { send: sent, landed: async () => false },
        () => {},
      ),
    ).rejects.toThrow(/approve didn't go through/u);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
