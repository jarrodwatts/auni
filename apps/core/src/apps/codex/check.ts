import type { BrainModelWire } from "@auni/shared";

import { scratchDir } from "../../agent/box.ts";
import type { BrainCheck } from "../contract.ts";
import { startAppServer, type AppServer } from "./app-server.ts";
import { LOGIN_FIX } from "./events.ts";
import { childEnv, codexCommand, codexHome, INSTALL_FIX, type ModelChoice } from "./options.ts";

/** Where the owner's Codex keeps its login: hidden from every brain's box. */
export function secrets(): readonly string[] {
  return [codexHome()];
}

interface Account {
  readonly type: string;
  readonly planType?: string;
  /** A ChatGPT login's email. */
  readonly email?: string | null;
}

/** The login as the owner knows it: "your ChatGPT Pro plan". */
export function loginOf(account: Account): string {
  if (account.type === "chatgpt" && account.planType) {
    const plan = account.planType.charAt(0).toUpperCase() + account.planType.slice(1);
    return `your ChatGPT ${plan} plan`;
  }
  if (account.type === "apiKey") return "the OpenAI API key in your Codex login";
  return `your Codex login (${account.type})`;
}

/** Says hello: every conversation with app-server starts this way. */
export async function hello(server: AppServer): Promise<void> {
  await server.request("initialize", {
    clientInfo: { name: "auni", title: "Auni", version: "0.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  server.notify("initialized");
}

/** The owner's account, or null when Codex isn't logged in. */
export async function account(server: AppServer): Promise<Account | null> {
  return (await server.request<{ account: Account | null }>("account/read", {})).account;
}

/**
 * Whether Codex keeps a login it can no longer use. A sign-in whose refresh token has expired
 * reads as no account at all (account/read gives `{ account: null }`), while getAuthStatus still
 * names how it was signed in; a machine never signed in has no method there either.
 */
async function keepsExpiredLogin(server: AppServer): Promise<boolean> {
  const status = await server.request<{ authMethod: string | null }>("getAuthStatus", {
    includeToken: false,
    refreshToken: false,
  });
  return status.authMethod !== null;
}

/** All models this Codex login lists. */
async function listModels(server: AppServer): Promise<ModelChoice[]> {
  const { data } = await server.request<{ data: ModelChoice[] }>("model/list", {});
  return data;
}

/** The chosen model (if listed), else the login's default model. */
export async function pickModel(
  server: AppServer,
  preferred?: string,
): Promise<ModelChoice | null> {
  const data = await listModels(server);
  if (preferred) {
    const match = data.find((model) => model.model === preferred);
    if (match) return match;
  }
  return data.find((model) => model.isDefault) ?? data[0] ?? null;
}

/** Models formatted for the composer model picker, leaving hidden entries out. */
function modelsForWire(data: readonly ModelChoice[]): BrainModelWire[] {
  const visible = data.filter((model) => !model.hidden);
  const shown = visible.length > 0 ? visible : data;
  return shown.map((model) => ({
    id: model.model,
    name: model.displayName ?? model.model,
    efforts: (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
  }));
}

/** The owner's own Codex, with none of a turn's box: to ask it about its login, or sign in. */
export function startPlain(command: string): AppServer {
  return startAppServer({ command, args: [], env: childEnv(null), cwd: scratchDir() });
}

/** Whether the owner's Codex is installed and logged in here. Asks no model anything. */
export async function check(signal: AbortSignal): Promise<BrainCheck> {
  const command = codexCommand();
  if (!command) return { ready: false, why: "not-installed", fix: INSTALL_FIX };
  const server = startPlain(command);
  // Killing it ends every request still waiting on an answer.
  signal.addEventListener("abort", () => server.close(), { once: true });
  try {
    await hello(server);
    const found = await account(server);
    if (!found)
      return {
        ready: false,
        why: (await keepsExpiredLogin(server)) ? "expired" : "signed-out",
        fix: LOGIN_FIX,
      };
    const listed = await listModels(server);
    if (listed.length === 0) return { ready: false, why: "signed-out", fix: LOGIN_FIX };
    return {
      ready: true,
      login: loginOf(found),
      ...(found.email ? { signedInAs: found.email } : {}),
      models: modelsForWire(listed),
    };
  } finally {
    server.close();
  }
}
