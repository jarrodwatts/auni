/**
 * The order a chat starts in from the owner's words. First run's part comes first (core makes
 * the wallet the owner didn't bring), then the chat, and only once the chat is there does first
 * run give way to the app. So a failure at any step leaves the page the words were typed on in
 * place, and `giveBack` puts them back in its box with the reason under it.
 */
export async function startInOrder<Chat>(steps: {
  readonly finishFirstRun: () => Promise<void>;
  readonly createChat: () => Promise<Chat>;
  readonly welcome: () => void;
  readonly open: (chat: Chat) => Promise<void>;
  readonly giveBack: () => Promise<void>;
}): Promise<void> {
  try {
    await steps.finishFirstRun();
    const chat = await steps.createChat();
    steps.welcome();
    await steps.open(chat);
  } catch {
    await steps.giveBack();
  }
}
