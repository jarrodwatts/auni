import { StartUnconfirmed } from "@/lib/data/places";
import type { SendFailure } from "@/lib/data/thread-session";

/**
 * Something that didn't work, as the owner reads it: what happened, then what it means for
 * their money, then the one thing to do about it.
 */
export interface ThreadFailure {
  /** What happened, in one short sentence. */
  readonly message: string;
  /** Whether their money moved, and anything else they'd ask next. */
  readonly money?: string;
  /**
   * The one way on: send the same message again (core stores it once),
   * ask again in its place, or read it all again.
   */
  readonly action?: "resend" | "ask_again" | "reload";
  /** Nothing was stored: the bubble goes and the words go back to the composer. */
  readonly returnsDraft?: true;
}

/** What each way on says on its button. */
export const FAILURE_ACTIONS: Record<NonNullable<ThreadFailure["action"]>, string> = {
  resend: "Send again",
  ask_again: "Ask again",
  reload: "Reload",
};

/** What a send that didn't become an answer means for the person. */
export const SEND_FAILURES: Record<SendFailure, ThreadFailure> = {
  unsent: {
    message: "Your message didn't reach Auni.",
    money: "Nothing was sent, and your message is back in the box below.",
    returnsDraft: true,
  },
  unconfirmed: {
    message: "Auni may not have heard your message.",
    money: "If Auni did get it, any move shows up as a card here. Sending again won't run it twice.",
    action: "resend",
  },
  // The turn may have started a move before it failed, maybe before its card reached the chat:
  // core tells the agent so once it ends (money/actions.ts), so it ends up told here either way.
  turn: {
    message: "Auni stopped before finishing this answer.",
    money: "Any move it had started carries on, and you'll see how it ends here.",
    action: "ask_again",
  },
};

export const HISTORY_FAILURE: ThreadFailure = {
  message: "Couldn't load this chat.",
  action: "reload",
};

/**
 * Why a chat didn't start, for the line under the box its words went back to. Core refused it, or
 * its answers were lost, when it may have started: then only the same words sent again can say.
 */
export function startFailure(error: unknown): string {
  return error instanceof StartUnconfirmed
    ? "Auni couldn't confirm this chat started. Your words are back in the box: send them again to open it."
    : "Auni couldn't start this chat. Your words are back in the box to send again.";
}
