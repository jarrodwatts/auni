import type { MessageId, SendMessageRequest, ThreadId, ThreadStreamEvent } from "@auni/shared";
import { readUIMessageStream, type UIMessageChunk } from "ai";

import { CoreApiError } from "@/lib/core";
import {
  createOptimisticUserMessage,
  toAuniMetadata,
  type AuniUiMessage,
} from "@/lib/conversation";
import { listThreadMessages, sendThreadMessage, stopThread, watchThread } from "@/lib/data/threads";

/**
 * One open conversation in this tab: its messages, the turn drawn now and the person's last
 * send. Core answers a send at once and streams every turn, sent here or not, over `/live`,
 * so every turn is drawn the same way: from the chunk that names its message to its
 * `turn-end`, when history (which then holds the answer) is read again. A drop in `/live`
 * reads history again too, so nothing waits on a timer: the turn on screen then shows as
 * thinking until its `turn-end`, or until that read says core runs no turn.
 *
 *   send: bubble, turn -> /live open now? -> POST (again once if the answer was lost)
 *   /live: start chunk -> follower draws it -> finish -> turn-end -> history read again
 */

/** Why a send didn't become an answer: never stored, maybe stored, or stored and its turn failed. */
export type SendFailure = "unsent" | "unconfirmed" | "turn";

/** The person's message this tab sent last, kept with the thread so a failure survives navigation. */
interface ThreadSendState {
  readonly messageId: string;
  readonly text: string;
  readonly failure: SendFailure | null;
}

interface ThreadSession {
  readonly messages: readonly AuniUiMessage[];
  readonly history: "loading" | "ready" | "failed";
  /** The turn drawn now; `sent` when this tab sent it. */
  readonly turn: {
    readonly id: string;
    readonly stage: "submitted" | "streaming";
    readonly sent: boolean;
  } | null;
  readonly send: ThreadSendState | null;
}

interface ThreadSessionHandle {
  /** Watches the thread while anyone listens; tells them at most every 50 ms. */
  subscribe(onChange: () => void): () => void;
  read(): ThreadSession;
  /** Never rejects: how it went is in `send`. */
  send(
    text: string,
    options?: { readonly id?: string; readonly supersedesId?: MessageId; readonly sentAt?: number },
  ): Promise<void>;
  stop(): Promise<void>;
  /** Reads history in whole, one read at a time; one asked for meanwhile runs after it. */
  resync(): Promise<void>;
}

/** How many conversations this tab keeps, so going back to one draws it at once. */
const MAX_SESSIONS = 24;
const NOTIFY_MS = 50;

const sessions = new Map<ThreadId, ReturnType<typeof createSession>>();

/** This tab's session for a thread. `isNew`: a thread just made, so its history is known empty. */
export function threadSession(
  threadId: ThreadId,
  options: { readonly isNew?: true } = {},
): ThreadSessionHandle {
  const session = sessions.get(threadId) ?? createSession(threadId, options.isNew === true);
  sessions.delete(threadId);
  sessions.set(threadId, session);
  for (const [id, other] of sessions) {
    if (sessions.size <= MAX_SESSIONS) break;
    // A live turn, a failed send (which may hold the only copy of words being handed back),
    // or a conversation on screen stays.
    if (id !== threadId && other.idle()) {
      other.release();
      sessions.delete(id);
    }
  }
  return session;
}

function createSession(threadId: ThreadId, isNew: boolean) {
  let state: ThreadSession = {
    messages: [],
    history: isNew ? "ready" : "loading",
    turn: null,
    send: null,
  };
  const listeners = new Set<() => void>();
  let notified = 0;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    notifyTimer = undefined;
    notified = Date.now();
    for (const listener of [...listeners]) listener();
  };
  const update = (change: Partial<ThreadSession>) => {
    state = { ...state, ...change };
    if (notifyTimer) return;
    const wait = notified + NOTIFY_MS - Date.now();
    if (wait <= 0) notify();
    else notifyTimer = setTimeout(notify, wait);
  };

  // A send waiting on `/live` (a stop then means it never goes), and one being posted.
  let opening: { stopped: boolean } | null = null;
  let posting: Promise<unknown> | null = null;
  // The turn on screen when `/live` dropped: its end may have gone unheard, so the next history
  // read says whether core still runs it.
  let unheard: string | null = null;
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  const resync = (): Promise<void> => {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        const asking = unheard;
        try {
          const { messages, running } = await listThreadMessages(threadId);
          if (unheard === asking) unheard = null;
          const { turn } = state;
          // A send still on its way may not be stored yet; its own POST settles it.
          const over = !running && turn !== null && turn.id === asking && posting === null;
          update({
            messages: withHistory(messages, state.messages),
            history: "ready",
            ...(over ? { turn: null } : {}),
          });
          if (over) release();
        } catch {
          // A conversation already on screen keeps it; the next read may do better.
          if (state.history !== "ready") update({ history: "failed" });
        }
      } while (syncAgain);
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  // Each turn drawn as it streams, by turn id. A turn first heard after its start chunk is
  // left to history: the chunk that names its message was missed, so a live copy would be a
  // stranger that outlives the stored one, below every later turn.
  const followers = new Map<string, ReadableStreamDefaultController<UIMessageChunk>>();
  const joinedLate = new Set<string>();
  const ended = new Set<string>();
  const endFollower = (turnId: string) => {
    try {
      followers.get(turnId)?.close();
    } catch {
      // Already closed.
    }
    followers.delete(turnId);
  };
  const begin = (turnId: string) => {
    let follower!: ReadableStreamDefaultController<UIMessageChunk>;
    const stream = new ReadableStream<UIMessageChunk>({ start: (c) => void (follower = c) });
    followers.set(turnId, follower);
    void (async () => {
      for await (const message of readUIMessageStream<AuniUiMessage>({ stream }))
        update({ messages: upsertMessage(state.messages, message) });
    })().catch(() => undefined);
    const { turn } = state;
    // A turn core started never takes the place of one this tab sent and still waits on.
    if (!turn || turn.id === turnId || !turn.sent)
      update({ turn: { id: turnId, stage: "streaming", sent: turn?.id === turnId && turn.sent } });
    return follower;
  };
  const follow = (turnId: string, chunks: readonly UIMessageChunk[]) => {
    if (joinedLate.has(turnId)) return;
    if (!followers.has(turnId) && chunks[0]?.type !== "start") {
      joinedLate.add(turnId);
      return;
    }
    const follower = followers.get(turnId) ?? begin(turnId);
    for (const chunk of chunks) {
      follower.enqueue(toChatChunk(chunk));
      if (chunk.type === "finish" || chunk.type === "abort") return endFollower(turnId);
    }
  };

  const onEvent = (event: ThreadStreamEvent<UIMessageChunk>) => {
    switch (event.kind) {
      // A card core left on its own, such as money arriving: drawn from history, beside any turn.
      case "posted":
        return void resync();
      case "progress": {
        if (ended.has(event.turnId)) return;
        const { turn } = state;
        // A turn core started, before its first words.
        if (
          turn?.id !== event.turnId &&
          !turn?.sent &&
          !state.messages.some(({ id }) => id === event.turnId)
        )
          update({ turn: { id: event.turnId, stage: "submitted", sent: false } });
        return;
      }
      case "chunks":
        return follow(event.turnId, event.chunks);
      case "turn-end": {
        ended.add(event.turnId);
        joinedLate.delete(event.turnId);
        endFollower(event.turnId);
        const { send, turn } = state;
        update({
          turn: turn?.id === event.turnId ? null : turn,
          send:
            event.failed && send?.messageId === event.turnId ? { ...send, failure: "turn" } : send,
        });
        void resync();
        return release();
      }
    }
  };
  // Whatever streamed while the socket was down was missed: history has it, or will by the
  // turn's end. The turn itself may still be running, so it stays, as thinking.
  const onGap = () => {
    for (const turnId of followers.keys()) {
      joinedLate.add(turnId);
      endFollower(turnId);
    }
    const { turn } = state;
    unheard = turn?.id ?? null;
    if (turn) update({ turn: { ...turn, stage: "submitted" } });
    void resync();
    release();
  };

  let live: ReturnType<typeof watchThread> | null = null;
  /** Settles once `/live` is open now, so everything from then on is heard. */
  const watch = (): Promise<void> => {
    if (!live) {
      live = watchThread(threadId, onEvent, onGap);
      // Nothing was heard while it wasn't watched.
      void resync();
    }
    return live.open();
  };

  const busy = () =>
    listeners.size > 0 || state.turn !== null || opening !== null || posting !== null;
  const release = () => {
    if (busy() || !live) return;
    live.close();
    live = null;
    for (const turnId of followers.keys()) endFollower(turnId);
  };

  const failSend = (id: string, failure: SendFailure) => {
    const { messages, send, turn } = state;
    const prompt = messages.findIndex((message) => message.id === id);
    update({
      // Nothing was stored, so its bubble goes and the words go back to the composer.
      messages: failure === "unsent" && prompt >= 0 ? messages.slice(0, prompt) : messages,
      turn: turn?.id === id ? null : turn,
      send: send?.messageId === id ? { ...send, failure } : send,
    });
  };

  const send: ThreadSessionHandle["send"] = async (text, options = {}) => {
    const id = options.id ?? crypto.randomUUID();
    const { supersedesId, sentAt } = options;
    // The same message sent again takes its own bubble's place.
    const bubble = createOptimisticUserMessage(id, text, {
      supersedesMessageId: supersedesId,
      sentAt,
    });
    update({
      messages: upsertMessage(state.messages, bubble),
      turn: { id, stage: "submitted", sent: true },
      send: { messageId: id, text, failure: null },
    });

    // Heard from before the message goes, so its first steps and words aren't missed.
    const waiting = { stopped: false };
    opening = waiting;
    const opened = await watch().then(
      () => true,
      () => false,
    );
    if (opening === waiting) opening = null;
    if (!opened) {
      failSend(id, "unsent");
      return release();
    }
    if (waiting.stopped) {
      const { messages, turn } = state;
      update({
        messages: messages.filter((message) => message.id !== id),
        turn: turn?.id === id ? null : turn,
        send: null,
      });
      return release();
    }

    const request = {
      id: id as SendMessageRequest["id"],
      text,
      ...(supersedesId ? { supersedesId } : {}),
    } satisfies SendMessageRequest;
    // A message holding a private key is kept out (see sendThreadMessage): its bubble goes, its
    // words don't come back to the composer, and history brings Auni's answer in its place.
    const post = () =>
      sendThreadMessage(threadId, request).then((keptOut) => {
        if (!keptOut) return null;
        const { messages, turn } = state;
        update({
          messages: messages.filter((message) => message.id !== id),
          turn: turn?.id === id ? null : turn,
          send: null,
        });
        void resync();
        return null;
      });
    const sending: Promise<SendFailure | null> = post().catch((error: unknown) =>
      error instanceof CoreApiError && error.status < 500
        ? "unsent"
        : // A lost response or a server fault may still have stored it: send it again, which
          // core stores once. The first may have gone through, so even a refusal now proves nothing.
          post().catch(() => "unconfirmed" as const),
    );
    posting = sending;
    const failure = await sending;
    posting = null;
    if (failure) failSend(id, failure);
    release();
  };

  const stop = async () => {
    // Pressed while `/live` was opening: the message never goes.
    if (opening) {
      opening.stopped = true;
      return;
    }
    // Over at once on screen: a queued turn core cancels never streams or ends, and one
    // running ends with its stopped answer, which history brings.
    update({ turn: null });
    const pending = posting;
    await stopThread(threadId);
    // Again once the send settles, in case core stored it after the first stop.
    if (pending) await pending.then(() => stopThread(threadId));
    release();
  };

  return {
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      void watch().catch(() => undefined);
      return () => {
        listeners.delete(onChange);
        release();
      };
    },
    read: () => state,
    send,
    stop,
    resync,
    idle: () => !busy() && !state.send?.failure,
    release,
  };
}

/** Stored history first; anything sent or streamed while it was read stays appended. */
function withHistory(
  loaded: readonly AuniUiMessage[],
  current: readonly AuniUiMessage[],
): readonly AuniUiMessage[] {
  const stored = new Set(loaded.map(({ id }) => id));
  return [...loaded, ...current.filter(({ id }) => !stored.has(id))];
}

function upsertMessage(
  messages: readonly AuniUiMessage[],
  message: AuniUiMessage,
): readonly AuniUiMessage[] {
  const index = messages.findIndex(({ id }) => id === message.id);
  return index < 0 ? [...messages, message] : messages.with(index, message);
}

/** A streamed chunk as the transcript reads it: the start carries Auni's message metadata. */
function toChatChunk(chunk: UIMessageChunk): UIMessageChunk {
  return chunk.type === "start"
    ? { ...chunk, messageMetadata: toAuniMetadata(chunk.messageMetadata) }
    : chunk;
}
