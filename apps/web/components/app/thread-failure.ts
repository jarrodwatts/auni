import type { SendFailure } from "@/lib/data/thread-session";

export interface ThreadFailure {
  readonly message: string;
  /**
   * The one Try again: send the same message again (core stores it once),
   * ask again in its place, or read the conversation again.
   */
  readonly action?: "resend" | "ask_again" | "reload";
  /** Nothing was stored: the bubble goes and the words go back to the composer. */
  readonly returnsDraft?: true;
}

/** What a send that didn't become an answer means for the person. */
export const SEND_FAILURES: Record<SendFailure, ThreadFailure> = {
  unsent: {
    message: "Your message didn't reach Auni, so nothing moved. It's back in the box below.",
    returnsDraft: true,
  },
  unconfirmed: {
    message: "Your message may not have reached Auni. Trying again won't send it twice.",
    action: "resend",
  },
  // The turn may have moved money before it failed; the cards above show what it did.
  turn: {
    message: "Auni couldn't finish this answer. Anything it did shows above.",
    action: "ask_again",
  },
};

export const HISTORY_FAILURE: ThreadFailure = {
  message: "This conversation couldn't load.",
  action: "reload",
};

export const START_FAILURE = "The conversation could not be started.";
