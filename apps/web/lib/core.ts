/**
 * The browser reaches core at /core on the web app's own origin, which proxy.ts passes on to
 * CORE_URL. Same-origin, so the owner's session cookie (HttpOnly, SameSite=Strict, host-only)
 * rides along on every request and nothing else carries a credential.
 */
const CORE_PATH = "/core";

/** A failed core request. Its message is for logs; what a person reads lives in the UI. */
export class CoreApiError extends Error {
  readonly status: number;
  /** Core's machine-readable reason, for the UI to pick its own words by. */
  readonly code: string | undefined;
  /** A sentence core wrote for the person, when the reason needs its specifics. */
  readonly detail: string | undefined;

  constructor(input: {
    readonly message: string;
    readonly status: number;
    readonly code?: string;
    readonly detail?: string;
  }) {
    super(input.message);
    this.name = "CoreApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

export async function requestCore(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const response = await fetch(`${CORE_PATH}/${path}`, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });

  if (!response.ok) throw await parseCoreApiError(response);
  if (response.status === 204) return undefined;
  return response.json();
}

async function parseCoreApiError(response: Response): Promise<CoreApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const field = (name: string): unknown =>
    typeof body === "object" && body !== null && name in body
      ? (body as Record<string, unknown>)[name]
      : undefined;
  const error = field("error");
  const detail = field("message");
  return new CoreApiError({
    message: `Core request failed with status ${response.status}`,
    status: response.status,
    ...(typeof error === "string" ? { code: error } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
  });
}
