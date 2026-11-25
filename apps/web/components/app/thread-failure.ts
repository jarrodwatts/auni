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
  // The turn may have moved money before it failed; the cards above show what it did.
  turn: {
    message: "Auni stopped before finishing this answer.",
    money: "If anything moved before it stopped, you'll see its card above.",
    action: "ask_again",
  },
};

export const HISTORY_FAILURE: ThreadFailure = {
  message: "Couldn't load this chat.",
  action: "reload",
};

export const START_FAILURE = "Couldn't start this chat, so nothing was sent. Try again.";
