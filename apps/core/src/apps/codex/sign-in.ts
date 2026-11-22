import type { SignInAttempt } from "../contract.ts";
import { hello, startPlain } from "./check.ts";
import { codexCommand, INSTALL_FIX } from "./options.ts";

interface DeviceCode {
  readonly loginId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
}

interface LoginCompleted {
  readonly loginId: string;
  readonly success: boolean;
  readonly error?: string | null;
}

/**
 * Codex's own device sign-in, `codex login --device-auth`, as its app server runs it: Codex asks
 * OpenAI for a one-time code, the owner opens OpenAI's page on any device and enters it there,
 * and Codex keeps the login it gets in its own home. The page and the code are all that pass
 * through Auni; the owner types nothing into it.
 */
export async function signIn({ signal, show }: SignInAttempt): Promise<void> {
  const command = codexCommand();
  if (!command) throw new Error(`Codex isn't installed here: ${INSTALL_FIX}`);
  const server = startPlain(command);
  // Killing it ends the sign-in Codex is waiting on, and every request still waiting.
  const stop = () => server.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await hello(server);
    const started = await server.request<DeviceCode>("account/login/start", {
      type: "chatgptDeviceCode",
    });
    show({ kind: "code", url: started.verificationUrl, code: started.userCode });
    for (;;) {
      const message = await server.next();
      if (!message) throw new Error(server.ended ?? "Codex stopped before the sign-in finished.");
      if (message.method !== "account/login/completed") continue;
      const done = message.params as LoginCompleted;
      if (done.loginId !== started.loginId) continue;
      if (done.success) return;
      throw new Error(done.error ?? "Codex says the sign-in didn't finish.");
    }
  } finally {
    signal.removeEventListener("abort", stop);
    server.close();
  }
}
