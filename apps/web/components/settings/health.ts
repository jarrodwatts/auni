import type { DoctorFindingWire } from "@auni/shared";

import { chatHref } from "@/lib/app-links";

/** Each part Auni checks, by the name the owner knows it by. */
const PARTS: Readonly<Record<string, string>> = {
  version: "Auni",
  database: "Auni's records",
  runner: "Auni's work",
  service: "Keeping Auni running",
  rpc: "Networks",
  brain: "Your AI",
  wallet: "Your wallet",
  apps: "Apps",
  web: "This web app",
  "always-on": "Reaching Auni",
};

export function partName(check: string): string {
  return PARTS[check] ?? check;
}

/** How Auni stands, in a line, and what of it needs the owner, first. */
export function healthOf(findings: readonly DoctorFindingWire[]): {
  readonly headline: string;
  readonly needs: readonly DoctorFindingWire[];
} {
  const needs = findings.filter(({ status }) => status === "fix");
  return {
    headline:
      needs.length === 0
        ? "Everything's working"
        : needs.length === 1
          ? "1 thing to fix"
          : `${needs.length} things to fix`,
    needs,
  };
}

/**
 * A link to each chat holding a card the finding is about, where the owner acts on it: a lone
 * one is just "Open chat", several are named so the owner can tell which is which.
 */
export function chatLinks(
  chats: DoctorFindingWire["chats"],
): readonly { readonly href: string; readonly label: string }[] {
  return chats.map(({ id, title }) => ({
    href: chatHref(id),
    label: chats.length === 1 ? "Open chat" : `Open ${title ?? "untitled chat"}`,
  }));
}
