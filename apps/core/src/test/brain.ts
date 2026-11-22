import { readUIMessageStream, type UIMessage } from "ai";

import { translate } from "../agent/translate.ts";
import type { BrainEvent } from "../apps/contract.ts";

/**
 * A brain's replayed events, as the web would store the message: through translate, which shows a
 * card only when an Auni tool returned it sealed. Each brain's events.test.ts replays its recorded
 * turns through this.
 */
export async function messageOf(events: readonly BrainEvent[]): Promise<UIMessage> {
  async function* source() {
    yield* events;
  }
  const chunks = translate(source(), { messageId: "m1" });
  let message: UIMessage | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  for await (const next of readUIMessageStream({ stream })) message = next;
  return message!;
}

/** The cards a stored message shows. */
export function cardsOf(message: UIMessage): Record<string, unknown>[] {
  return message.parts.flatMap((part) =>
    part.type === "data-cards" ? (part.data as { cards: Record<string, unknown>[] }).cards : [],
  );
}
