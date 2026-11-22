/**
 * The one-time pairing code a link carries in its fragment (`/app#pair=<code>`), which the
 * browser never sends to a server; null for any other address.
 */
export function pairingCodeIn(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/u, "")).get("pair");
  return code && /^[\w-]{1,200}$/u.test(code) ? code : null;
}
