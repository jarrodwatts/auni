import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// `codex app-server`: newline-delimited JSON-RPC over the child's stdin and stdout (with or
// without a "jsonrpc" field). Core asks it things; it streams notifications and, now and then,
// asks core something back, which core always answers at once so nothing waits on a person.

export interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** One line on the wire, either way: what a recording keeps. */
export interface WireLine {
  readonly from: "core" | "codex";
  readonly message: RpcMessage;
}

const STDERR_TAIL_CHARS = 2_000;

/**
 * Core's answer to a request codex sends it. Auni's box is read-only and no one is there to
 * approve anything, so every approval and every question for the owner is declined, and
 * anything else (a login refresh, an attestation) is a method core doesn't have.
 */
export function answerTo(method: string): Pick<RpcMessage, "result" | "error"> {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline", content: null, _meta: null } };
    default:
      return { error: { code: -32601, message: `Auni doesn't answer ${method}.` } };
  }
}

export interface AppServer {
  request<Result>(method: string, params?: unknown): Promise<Result>;
  notify(method: string, params?: unknown): void;
  /** The next notification, or null once the process has ended. */
  next(): Promise<RpcMessage | null>;
  /** Why the process ended, with the tail of what it printed; null while it runs. */
  readonly ended: string | null;
  close(): void;
}

interface StartOptions {
  /** The `codex` command to run (codexCommand). */
  readonly command: string;
  readonly args: readonly string[];
  /** Exactly the child's environment, never a copy of core's. */
  readonly env: Record<string, string>;
  /** Codex leaves files of its own where it starts, so this is the scratch folder. */
  readonly cwd: string;
  readonly onLine?: (line: WireLine) => void;
}

export function startAppServer({ command, args, env, cwd, onLine }: StartOptions): AppServer {
  const child = spawn(command, ["app-server", ...args], {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let ended: string | null = null;
  let nextId = 0;
  const pending = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  const queue: RpcMessage[] = [];
  let waiting: ((message: RpcMessage | null) => void) | null = null;

  const send = (message: RpcMessage) => {
    if (ended) return;
    onLine?.({ from: "core", message });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const end = (why: string) => {
    if (ended) return;
    ended = stderr.trim() ? `${why}\n${stderr.trim()}` : why;
    for (const { reject } of pending.values()) reject(new Error(ended));
    pending.clear();
    waiting?.(null);
    waiting = null;
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr = (stderr + data).slice(-STDERR_TAIL_CHARS);
  });
  child.on("error", (error) => end(`Codex didn't start: ${error.message}`));
  child.on("exit", (code, signal) => end(`Codex stopped (${signal ?? `exit ${code}`}).`));
  child.stdin.on("error", () => {}); // a write after it exited; `exit` says why

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return; // not protocol: a stray print
    }
    onLine?.({ from: "codex", message });
    if (message.method !== undefined && message.id !== undefined) {
      send({ id: message.id, ...answerTo(message.method) });
    } else if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        call?.reject(new Error(`${message.error.message} (${message.error.code})`));
      else call?.resolve(message.result);
    } else if (waiting) {
      waiting(message);
      waiting = null;
    } else {
      queue.push(message);
    }
  });

  return {
    request<Result>(method: string, params: unknown = {}) {
      if (ended) return Promise.reject(new Error(ended));
      const id = ++nextId;
      return new Promise<Result>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send(params === undefined ? { method } : { method, params });
    },
    next() {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => (waiting = resolve));
    },
    get ended() {
      return ended;
    },
    close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}
