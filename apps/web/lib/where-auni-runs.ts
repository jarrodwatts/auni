import { useSyncExternalStore } from "react";

/**
 * The machine Auni runs on, as this browser reached it: null when it is this computer (the
 * browser opened it at localhost), else the machine's own name, "evo-t1" for
 * evo-t1.tail1234.ts.net. Read from the address alone, so a page that isn't signed in can say it.
 */
export function remoteMachine(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./u.test(host))
    return null;
  // An address, not a name: shown as it is.
  if (host.includes(":") || /^[\d.]+$/u.test(host)) return host;
  return host.split(".")[0] || host;
}

const unchanging = () => () => {};

/** `remoteMachine` for this page's address; null while drawn on the server. */
export function useRemoteMachine(): string | null {
  return useSyncExternalStore(
    unchanging,
    () => remoteMachine(window.location.hostname),
    () => null,
  );
}
