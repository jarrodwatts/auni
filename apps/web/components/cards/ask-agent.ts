/** Sends a follow-up into the thread; resolves false when the thread is busy and refuses it. */
export type AskAgentHandler = (prompt: string) => Promise<boolean>;
