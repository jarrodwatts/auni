import { setTimeout as sleep } from "node:timers/promises";

import { APP_LISTINGS } from "@auni/shared";

import type { Channel } from "../apps/contract.ts";
import { onLive } from "../conversation/stream.ts";

const TYPING_MS = 4_000;
const STATUS_AFTER_MS = 2 * TYPING_MS;
const QUEUED_LIMIT_MS = 3 * 60_000;
const DELIVERY_LIMIT_MS = 5 * 60_000;
const WORKING = "Working on your reply…";
const toolApps = new Map(
  APP_LISTINGS.flatMap(({ name, tools }) => Object.keys(tools ?? {}).map((tool) => [tool, name])),
);

function activity(tool: string): string {
  const app = toolApps.get(tool);
  if (app) return `Checking ${app}…`;
  switch (tool) {
    case "get_portfolio":
      return "Checking your balances…";
    case "WebSearch":
    case "WebFetch":
    case "fetch_url":
      return "Looking up information…";
    default:
      return WORKING;
  }
}

interface Progress {
  readonly chat: string;
  readonly stop: () => Promise<string | undefined>;
}

const running = new Map<string, Progress>();
const statusKey = (channel: string, replyTo: string) => `${channel}:${replyTo}`;

/** One status per incoming message. Only live events from that message's turn can update it. */
export function showTurn(input: {
  readonly channelId: string;
  readonly channel: Channel;
  readonly chat: string;
  readonly replyTo: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly stillPaired: () => Promise<boolean>;
}): void {
  const { channel, chat, replyTo } = input;
  const key = statusKey(input.channelId, replyTo);
  if (running.has(key)) return;
  const abort = new AbortController();
  const queued = Date.now();
  let began: number | undefined;
  let text = WORKING;
  let shown: string | undefined;
  let ref: string | undefined;
  let triedStatus = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const forget = () => {
    if (running.get(key) === progress) running.delete(key);
  };
  const off = onLive((message) => {
    if (message.topic === "gone" && message.threadId === input.threadId) {
      forget();
      void progress.stop();
      return;
    }
    if (message.topic !== "thread" || message.threadId !== input.threadId) return;
    const { event } = message;
    if (!("turnId" in event) || event.turnId !== input.turnId) return;
    if (event.kind === "progress" || event.kind === "chunks") began ??= Date.now();
    if (event.kind === "chunks") {
      for (const chunk of event.chunks)
        if (chunk.type === "tool-input-available") text = activity(chunk.toolName);
    }
    if (event.kind === "turn-end") {
      void progress.stop();
      if (event.stopped) {
        forget();
        void work
          .then(async (id) => {
            if (id && (await input.stillPaired()))
              await channel.edit(id, {
                text: "Reply stopped. Check this chat in Auni for any moves.",
              });
          })
          .catch(() => undefined);
      } else {
        // Usually delivery takes the status next. Forget it if the delivery never runs.
        expiry = setTimeout(forget, DELIVERY_LIMIT_MS);
        expiry.unref();
      }
    }
  });

  const progress: Progress = {
    chat,
    stop: async () => {
      off();
      abort.abort();
      clearTimeout(expiry);
      return work;
    },
  };
  running.set(key, progress);

  const work = update()
    .catch(() => ref)
    .finally(() => {
      off();
      if (!abort.signal.aborted) forget();
    });
  async function update(): Promise<string | undefined> {
    let typed = false;
    while (
      !abort.signal.aborted &&
      (began !== undefined || Date.now() - queued < QUEUED_LIMIT_MS)
    ) {
      if (!(await input.stillPaired()) || abort.signal.aborted) break;
      const current = text;
      try {
        if (began === undefined || Date.now() - began < STATUS_AFTER_MS) {
          if (!typed || began !== undefined) {
            typed = true;
            await channel.typing(chat);
          }
        } else if (!triedStatus) {
          triedStatus = true;
          [ref] = await channel.send(chat, { text: current }, replyTo);
          if (ref) shown = current;
        } else if (ref && shown !== current) {
          if (!(await channel.edit(ref, { text: current }))) break;
          shown = current;
        }
      } catch {
        // The reply still goes out through its own job if the status couldn't be shown.
      }
      await sleep(TYPING_MS, undefined, { signal: abort.signal, ref: false }).catch(
        () => undefined,
      );
    }
    return ref;
  }
}

/** Stop updating before the delivery edits the answer into the status message. */
export async function takeTurnStatus(channel: string, chat: string, replyTo?: string) {
  if (!replyTo) return;
  const key = statusKey(channel, replyTo);
  const progress = running.get(key);
  if (progress?.chat !== chat) return;
  running.delete(key);
  return progress.stop();
}
