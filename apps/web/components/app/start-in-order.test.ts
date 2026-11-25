import { describe, expect, it } from "vitest";

import { startInOrder } from "./start-in-order";

// The owner's first take is the one message that must never be lost: whichever step fails, the
// words go back to the box first run asked for them in, and first run only ends once the chat
// they started is there.

function steps(fails?: "finish" | "create" | "open") {
  const done: string[] = [];
  const step = (name: string) => async () => {
    done.push(name);
    if (fails === name) throw new Error(`${name} failed`);
  };
  return {
    done,
    steps: {
      finishFirstRun: step("finish"),
      createChat: async () => {
        await step("create")();
        return "chat";
      },
      welcome: () => void done.push("welcome"),
      open: async (chat: string) => {
        await step("open")();
        done.push(`opened ${chat}`);
      },
      giveBack: async () => void done.push("give back"),
    },
  };
}

describe("starting a chat from the owner's words", () => {
  it("ends first run only once the chat is there, then opens it", async () => {
    const { done, steps: all } = steps();
    await startInOrder(all);
    expect(done).toEqual(["finish", "create", "welcome", "open", "opened chat"]);
  });

  it("gives the words back, still in first run, when core can't make the wallet", async () => {
    const { done, steps: all } = steps("finish");
    await startInOrder(all);
    expect(done).toEqual(["finish", "give back"]);
  });

  it("gives the words back, still in first run, when the chat can't be made", async () => {
    const { done, steps: all } = steps("create");
    await startInOrder(all);
    expect(done).toEqual(["finish", "create", "give back"]);
  });
});
