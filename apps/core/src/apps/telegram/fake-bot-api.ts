import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for Telegram's Bot API, for tests only: it queues updates for getUpdates, answers
// the methods the channel calls the way Telegram does, and keeps every call to look at.

export const FAKE_TOKEN = "123456:fake-token";

/** Where a bot's message ids start; Telegram numbers each bot's messages on their own. */
const FIRST_MESSAGE = 100;

interface FakeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface Person {
  /** The sender's numeric id. */
  readonly from: number;
  /** The chat it happens in; a person's direct chat with a bot has their own id. */
  readonly chat?: number;
  readonly chatType?: "private" | "group" | "supergroup";
}

export class FakeBotApi {
  readonly calls: FakeCall[] = [];
  private server: Server | undefined;
  private updates: { update_id: number }[] = [];
  private nextUpdate = 1;
  private token = FAKE_TOKEN;
  private nextMessage = FIRST_MESSAGE;
  private readonly deleted = new Set<number>();
  private readonly hangs = new Set<string>();
  /** Every update below this has been handled: getUpdates asked from past it. */
  private confirmed = 0;
  private wake: (() => void) | undefined;
  private readonly fails = new Map<string, string>();

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        void this.answer(req.url ?? "", body ? JSON.parse(body) : {}).then((answer) => {
          res.writeHead(answer.ok ? 200 : (answer.error_code as number), {
            "content-type": "application/json",
          });
          res.end(JSON.stringify(answer));
        });
      });
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.wake?.();
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** The next call of `method` fails as Telegram says `description`. */
  failNext(method: string, description: string): void {
    this.fails.set(method, description);
  }

  /** The next call of `method` is never answered, as when a laptop sleeps mid-request. */
  hangNext(method: string): void {
    this.hangs.add(method);
  }

  /** The owner moves to a new bot: only its token works now, and its messages count from the start. */
  useBot(token: string): void {
    this.token = token;
    this.nextMessage = FIRST_MESSAGE;
    this.deleted.clear();
  }

  /** The owner deletes a message in their chat, so it can no longer be edited. */
  deleteMessage(id: number): void {
    this.deleted.add(id);
  }

  sent(method: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  /** A text message someone sends the bot. */
  message(person: Person, text: string, replyTo?: number): number {
    const chat = person.chat ?? person.from;
    const id = this.nextMessage++;
    this.push({
      message: {
        message_id: id,
        from: { id: person.from, is_bot: false },
        chat: { id: chat, type: person.chatType ?? "private" },
        text,
        ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
      },
    });
    return id;
  }

  /** A press of a button carrying `data` under message `messageId`. */
  press(person: Person, messageId: number, data: string): string {
    const chat = person.chat ?? person.from;
    const id = `press-${this.nextUpdate}`;
    this.push({
      callback_query: {
        id,
        from: { id: person.from, is_bot: false },
        message: { message_id: messageId, chat: { id: chat, type: person.chatType ?? "private" } },
        data,
      },
    });
    return id;
  }

  /** Resolves once the channel has handled every update queued so far. */
  async handled(): Promise<void> {
    const last = this.nextUpdate - 1;
    while (this.confirmed <= last) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdate++, ...update });
    this.wake?.();
  }

  private async answer(url: string, params: Record<string, unknown>) {
    const [, token, method = ""] = /^\/bot([^/]+)\/(\w+)$/u.exec(url) ?? [];
    if (token !== this.token) return { ok: false, error_code: 401, description: "Unauthorized" };
    this.calls.push({ method, params });
    if (this.hangs.delete(method)) return new Promise<never>(() => {});
    const failure = this.fails.get(method);
    if (failure) {
      this.fails.delete(method);
      return { ok: false, error_code: 400, description: failure };
    }
    switch (method) {
      case "getUpdates":
        return { ok: true, result: await this.poll(Number(params.offset ?? 0)) };
      case "sendMessage":
        return {
          ok: true,
          result: {
            message_id: this.nextMessage++,
            chat: { id: Number(params.chat_id), type: "private" },
            text: params.text,
          },
        };
      case "getMe":
        return {
          ok: true,
          result: { id: Number(this.token.split(":")[0]), is_bot: true, username: "auni_test_bot" },
        };
      case "editMessageText":
        if (this.deleted.has(Number(params.message_id)))
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: message to edit not found",
          };
        return { ok: true, result: true };
      case "answerCallbackQuery":
      case "setMyCommands":
      case "setMessageReaction":
      case "sendChatAction":
        return { ok: true, result: true };
      default:
        return { ok: false, error_code: 404, description: "Not Found" };
    }
  }

  /** getUpdates: confirms what came before `offset`, then waits briefly for anything new. */
  private async poll(offset: number) {
    this.confirmed = Math.max(this.confirmed, offset);
    this.updates = this.updates.filter((update) => update.update_id >= offset);
    if (this.updates.length === 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    this.wake = undefined;
    return this.updates;
  }
}
