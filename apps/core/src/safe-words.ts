import { env } from "./env.ts";

// What a library or a service said, made safe to tell the agent, a card and a channel. An
// error's message can carry the link it called, and a node's link can carry the owner's key in
// its path or query (viem's says "URL: " and the whole link), or quote the key alone. So every
// link is cut down to its host, and each of core's own secrets is taken out.

const LINKS: readonly (readonly [RegExp, string | ((found: string) => string)])[] = [
  // JSON escapes a link's slashes: "https:\/\/rpc.example\/KEY".
  [/\\\//gu, "/"],
  // Up to the end of the link: a stop, a comma or a colon after it is the sentence's.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]*[^\s"'<>)\].,:;!?]/giu, (link) => hostOf(link)],
  // A host with a path, a query or a port after it, and no scheme: "rpc.quiknode.pro/KEY".
  [/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?[/?#][^\s"'<>)\]]*/giu, "$1"],
];

/** `text` with every link in it cut down to its host, written with a scheme or without one. */
export function cutLinks(text: string): string {
  return LINKS.reduce(
    (kept, [shape, by]) => kept.replace(shape, by as (found: string) => string),
    text,
  );
}

/**
 * Core's own secrets as an error may quote them: the Alchemy key, the turn-token secret, the
 * database's link and each RPC's, with each piece of those links. A value too short to be a key
 * is left, since it could be any word.
 */
export function coreSecrets(): string[] {
  const own = [env.ALCHEMY_API_KEY, env.TURN_TOKEN_SECRET, env.DATABASE_URL];
  return [...own, ...Object.values(env.RPC_URLS)]
    .flatMap((value) => (value ? [value, ...pieces(value)] : []))
    .filter((value) => value.length >= 8);
}

/** A link's password, and each piece of its path and query, which an error may quote alone. */
export function pieces(value: string): string[] {
  try {
    const url = new URL(value);
    return [
      decodeURIComponent(url.password),
      ...url.pathname.split("/"),
      ...[...url.searchParams.values()],
    ];
  } catch {
    return [];
  }
}

/** An error as the agent and the owner are told it: its message, safe to tell (see above). */
export function errorWords(error: unknown): string {
  const message = cutLinks(error instanceof Error ? error.message : String(error));
  return coreSecrets()
    .toSorted((a, b) => b.length - a.length)
    .reduce((kept, secret) => kept.replace(new RegExp(escaped(secret), "giu"), "…"), message);
}

export const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function hostOf(link: string): string {
  try {
    return new URL(link).hostname || "a link";
  } catch {
    return "a link";
  }
}
