// Telegram's Bot API (core.telegram.org/bots/api): every method is a POST of JSON to
// <api>/bot<token>/<method>, answered with { ok, result } or { ok: false, error_code, description }.
// The token sits in the URL, so no URL, and nothing that may carry one, leaves this file in an error.

export class BotApiError extends Error {
  readonly method: string;
  readonly code: number;
  readonly description: string;
  /** Seconds Telegram asks to wait, when it limits the rate. */
  readonly retryAfter?: number;

  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`Telegram's ${method} failed (${code}): ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export type BotApi = <Result>(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Result>;

interface Answer {
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error_code?: number;
  readonly description?: string;
  readonly parameters?: { readonly retry_after?: number };
}

/**
 * How long Telegram has to answer, past any long poll's own wait (`timeout`). Without a limit a
 * request lost when the laptop slept would hang for minutes, and every press behind it.
 */
const ANSWER_WITHIN_MS = 15_000;

export function botApi(apiUrl: string, token: string, answerWithinMs = ANSWER_WITHIN_MS): BotApi {
  return async <Result>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result> => {
    const polling = typeof params.timeout === "number" ? params.timeout * 1_000 : 0;
    const late = AbortSignal.timeout(polling + answerWithinMs);
    let response: Response;
    let body: string;
    try {
      response = await fetch(`${apiUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, late]) : late,
      });
      body = await response.text();
    } catch {
      // The failure's own message or cause may name the URL, and with it the token.
      throw new BotApiError(
        method,
        0,
        signal?.aborted
          ? "stopped"
          : late.aborted
            ? "Telegram didn't answer in time"
            : "Telegram couldn't be reached",
      );
    }
    const answer = parsed(body);
    if (!answer?.ok)
      throw new BotApiError(
        method,
        answer?.error_code ?? response.status,
        answer?.description ?? response.statusText,
        answer?.parameters?.retry_after,
      );
    return answer.result as Result;
  };
}

function parsed(body: string): Answer | null {
  try {
    return JSON.parse(body) as Answer;
  } catch {
    return null;
  }
}

/** The parts of an update Auni reads. */
export interface Update {
  readonly update_id: number;
  readonly message?: Message;
  readonly callback_query?: {
    readonly id: string;
    readonly from: User;
    readonly message?: Message;
    readonly data?: string;
  };
}

export interface Message {
  readonly message_id: number;
  readonly from?: User;
  readonly chat: { readonly id: number; readonly type: string };
  readonly text?: string;
  readonly caption?: string;
  readonly reply_to_message?: { readonly message_id: number };
}

interface User {
  readonly id: number;
  readonly is_bot: boolean;
}
