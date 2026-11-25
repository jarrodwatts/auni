import { describe, expect, it } from "vitest";

import { CoreApiError } from "@/lib/core";

import { startInOrder } from "./start-in-order";
import { startFailure } from "./thread-failure";

// The owner's first take is the one message that must never be lost: whichever step fails, the
// words go back to the box first run asked for them in, with what failed under it, and first run
// only ends once the chat they started is there.

function steps(fails?: Error) {
  const done: string[] = [];
  return {
    done,
    steps: {
      createChat: async () => {
        done.push("create");
        if (fails) throw fails;
        return "chat";
      },
      welcome: () => void done.push("welcome"),
      open: async (chat: string) => void done.push(`opened ${chat}`),
      giveBack: async (error: unknown) => void done.push(`give back: ${startFailure(error)}`),
    },
  };
}

describe("starting a chat from the owner's words", () => {
  it("ends first run only once the chat is there, then opens it", async () => {
    const { done, steps: all } = steps();
    await startInOrder(all);
    expect(done).toEqual(["create", "welcome", "opened chat"]);
  });

  it("gives the words back with why when the chat didn't start", async () => {
    const { done, steps: all } = steps(new CoreApiError({ message: "", status: 400 }));
    await startInOrder(all);
    expect(done).toEqual([
      "create",
      "give back: Auni couldn't start this chat. Your words are back in the box to send again.",
    ]);
  });
});
