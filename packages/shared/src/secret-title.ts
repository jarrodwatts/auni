/** First words of a field's label that are plain words, not names: they read lower case in a phrase. */
const PLAIN = new Set([
  "Access",
  "Bot",
  "Builder",
  "Private",
  "Recovery",
  "Secret",
  "Sign-in",
  "Wallet",
]);

/**
 * What a card asking for a secret says at its head: Auni's ask, in the owner's words. A field
 * named for its service keeps that name ("Paste your Elfa key"); a plain one reads as a phrase
 * ("Paste your sign-in code"). "API key" is plumbing, so it reads as a key.
 */
export function secretTitle(label: string): string {
  const named = label
    .replace(/^Your\s+/u, "")
    .replace(/\bAPI key\b/u, "key")
    .trim();
  const first = named.split(" ")[0] ?? "";
  const phrase = PLAIN.has(first) ? named.charAt(0).toLowerCase() + named.slice(1) : named;
  return `Paste your ${phrase}`;
}
