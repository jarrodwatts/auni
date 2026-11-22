// Telegram shows a message's formatting from a small HTML subset (<b>, <i>, <s>, <code>, <pre>,
// <a href>), and refuses a message whose tags don't parse; the channel then sends it as plain
// text. Everything else is escaped, so what Auni writes can't add a tag of its own.

/** Telegram's limit is 4096 characters; this leaves room for what the tags add. */
const MAX_CHARS = 3_500;

function escape(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** Markdown, as the agent writes it, in Telegram's HTML. */
export function toHtml(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/u)
    .map((piece, index) => (index % 2 === 1 ? fenced(piece) : inline(piece)))
    .join("");
}

function fenced(block: string): string {
  // The opening fence may name a language on its own line.
  const body = block.slice(3, -3).replace(/^[\w+-]*\n/u, "");
  return `<pre>${escape(body.replace(/\n$/u, ""))}</pre>`;
}

function inline(text: string): string {
  return text
    .split(/((?<!\\)`[^`\n]*[^`\n\\]`)/u)
    .map((piece, index) =>
      index % 2 === 1 ? `<code>${escape(piece.slice(1, -1))}</code>` : prose(piece),
    )
    .join("");
}

/**
 * A mark after a backslash is the mark itself, as Markdown says (core draws words from outside
 * so): it is set aside as a character no rule below reads, and put back once they have run.
 */
const ESCAPED = /\\([!-/:-@[-`{-~])/gu;
const SET_ASIDE = 0xe000;
const setAside = (text: string) =>
  text.replace(ESCAPED, (_match, mark: string) =>
    String.fromCodePoint(SET_ASIDE + mark.charCodeAt(0)),
  );
const putBack = (html: string) =>
  html.replace(/[\ue000-\ue07f]/gu, (held) =>
    escape(String.fromCodePoint(held.codePointAt(0)! - SET_ASIDE)),
  );

function prose(text: string): string {
  return putBack(formatted(escape(setAside(text))));
}

function formatted(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+(.+)$/gmu, "<b>$1</b>")
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
      (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
    )
    .replace(/\*\*([^*\n]+?)\*\*/gu, "<b>$1</b>")
    .replace(/__([^_\n]+?)__/gu, "<b>$1</b>")
    .replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/gmu, "$1<i>$2</i>")
    .replace(/~~([^~\n]+?)~~/gu, "<s>$1</s>");
}

/** A long answer as several messages, cut where a paragraph, line or word ends. */
export function chunks(text: string, max = MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const at = [
      rest.lastIndexOf("\n\n", max),
      rest.lastIndexOf("\n", max),
      rest.lastIndexOf(" ", max),
    ].find((cut) => cut > max / 2);
    const cut = at ?? max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
