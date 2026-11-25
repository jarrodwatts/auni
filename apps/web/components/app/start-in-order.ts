/**
 * The order a chat starts in from the owner's words: core makes the chat with their words in it
 * (and, for a new owner's first take, the wallet they didn't bring when it can, ending first
 * run), and only once it's there does the page give way to it. So a failure leaves the page the
 * words were typed on in place, and `giveBack` puts them back in its box with what failed under it.
 */
export async function startInOrder<Chat>(steps: {
  readonly createChat: () => Promise<Chat>;
  readonly welcome: () => void;
  readonly open: (chat: Chat) => Promise<void>;
  readonly giveBack: (error: unknown) => Promise<void>;
}): Promise<void> {
  try {
    const chat = await steps.createChat();
    steps.welcome();
    await steps.open(chat);
  } catch (error) {
    await steps.giveBack(error);
  }
}
