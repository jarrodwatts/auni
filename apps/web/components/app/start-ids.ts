import type { ThreadId } from "@auni/shared";
import { z } from "zod";

/** The ids a new chat is asked for under: core makes a chat once per pair, however often asked. */
export interface StartIds {
  readonly threadId: ThreadId;
  readonly messageId: string;
}

const storageKey = "auni:composer-draft:new:start";

/**
 * The ids to start a chat from these words with. A start whose answer never came may still have
 * made its chat, so its ids stay in this tab (through a reload, beside the draft its words went
 * back to) until one with them is answered: sending the same words again gets that chat back
 * from core, never a second one. Other words start a chat of their own.
 */
export function startIdsFor(text: string): StartIds {
  const kept = readKept();
  if (kept?.text === text) return { threadId: kept.threadId, messageId: kept.messageId };
  const ids: StartIds = {
    threadId: crypto.randomUUID() as ThreadId,
    messageId: crypto.randomUUID(),
  };
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ text, ...ids }));
  } catch {
    // Storage being full or blocked must never stop a chat starting.
  }
  return ids;
}

/** Core answered with the chat: these words' next start is a new chat. */
export function forgetStartIds(ids: StartIds): void {
  try {
    if (readKept()?.threadId === ids.threadId) window.sessionStorage.removeItem(storageKey);
  } catch {
    // As above.
  }
}

const keptSchema = z.object({ text: z.string(), threadId: z.string(), messageId: z.string() });

function readKept(): (StartIds & { readonly text: string }) | null {
  try {
    const kept = keptSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null"));
    return kept.success ? { ...kept.data, threadId: kept.data.threadId as ThreadId } : null;
  } catch {
    // Blocked or unreadable storage holds nothing.
    return null;
  }
}
