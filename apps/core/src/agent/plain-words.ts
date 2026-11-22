import { z } from "zod";

/**
 * The agent's own words as a card may draw them: a title, a name, a sentence. Nothing checks
 * what they say, so they carry nothing that acts, draws or hides: they stay on one line, with
 * no mark that can't be seen (a control character, a line or paragraph separator, a mark that
 * reverses the text after it or takes no room), no markup a channel could draw (angle brackets,
 * a backtick, Markdown's brackets, stars and doubled marks), and nothing shaped like a link (a
 * scheme, "www.", a domain such as "evil.example", or "@" as in an address or a chat's handle).
 * A channel that turns a bare domain into a link, as Telegram does, has none to make.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;
const MARKUP = /[<>`[\]*]|~~|__/u;
const LINK = /:\/\/|www\.|[\p{L}\p{N}-][.。．｡]\p{L}{2,}|@/iu;

export const isPlainWords = (text: string): boolean =>
  !UNSEEN.test(text) && !MARKUP.test(text) && !LINK.test(text);

/** The agent's words for a card, of at most `max` characters, as `isPlainWords` takes them. */
export const plainWords = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(isPlainWords, "Plain words on one line: no line break, no link or domain, no markup.");
