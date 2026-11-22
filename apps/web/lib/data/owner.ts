import { requestCore } from "@/lib/core";

/**
 * Spends the one-time code from the link `auni` opened (or `auni pair` printed); core answers
 * with the owner's session cookie. A refused code comes back as a CoreApiError.
 */
export async function pairBrowser(code: string): Promise<void> {
  await requestCore("owner/pair", { method: "POST", body: JSON.stringify({ code }) });
}

/**
 * Why core isn't answering, from its health through the web app's proxy: "starting" while no
 * core answers yet (the proxy fails), "database" when core answers but can't reach its database.
 */
export async function whyUnreachable(): Promise<"starting" | "database"> {
  const health = await fetch("/core/health", { cache: "no-store" }).catch(() => null);
  return health?.status === 503 ? "database" : "starting";
}
