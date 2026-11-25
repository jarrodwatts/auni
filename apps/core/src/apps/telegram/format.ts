// Telegram shows a message's formatting from a small HTML subset (<b>, <i>, <s>, <code>, <pre>,
// <a href>), and refuses a message whose tags don't parse; the channel then sends it as plain
// text. Everything else is escaped, so what Auni writes can't add a tag of its own.

/** Telegram's limit is 4096 characters; this leaves room for what the tags add. */
export const MESSAGE_CHARS = 3_500;

function escape(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** Markdown, as the agent writes it, in Telegram's HTML. */
export function toHtml(markdown: string, limit = MESSAGE_CHARS): string {
  let room = limit - markdown.length;
  return markdown
    .split(/(```[\s\S]*?```)/u)
    .map((piece, index) => {
      if (index % 2 === 1) return fenced(piece);
      const expanded = mobileTables(piece, room);
      room -= expanded.length - piece.length;
      return blocks(expanded);
    })
    .join("");
}

/** A fold is one Telegram entity. Flatten any Markdown quotes inside it. */
export function detailHtml(markdown: string): string {
  return `<blockquote expandable>${inline(markdown)}</blockquote>`;
}

function mobileTables(text: string, room: number): string {
  return text.replace(
    /(^ *\|[^\n]+\| *\n)( *\|[:\s|-]+\| *)(\n(?: *\|[^\n]+\| *(?:\n|$))+)/gmu,
    (table, heading: string, separator: string, body: string) => {
      const cells = (row: string) =>
        row
          .trim()
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
      const names = cells(heading);
      const rules = cells(separator);
      const rows = body.trim().split("\n").map(cells);
      if (
        rules.length !== names.length ||
        !rules.every((rule) => /^:?-{3,}:?$/u.test(rule)) ||
        rows.some((row) => row.length !== names.length)
      )
        return table;
      const expanded =
        rows
          .map((row) => row.map((value, index) => `${names[index]}: ${value}`).join("\n"))
          .join("\n\n") + (table.endsWith("\n") ? "\n" : "");
      const growth = expanded.length - table.length;
      if (growth > room) return table;
      room -= growth;
      return expanded;
    },
  );
}

function blocks(text: string): string {
  return text
    .split(/(^> ?[^\n]*(?:\n> ?[^\n]*)*)/gmu)
    .map((piece, index) =>
      index % 2 === 1
        ? `<blockquote>${inline(piece.replace(/^> ?/gmu, ""))}</blockquote>`
        : inline(piece.replace(/^([ \t]*)[-+*] /gmu, "$1• ")),
    )
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
    .split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gu)
    .map((piece, index) => {
      if (index % 2 === 0) return emphasis(piece);
      const [, label = "", url = ""] = /^\[([^\]\n]+)\]\(([^)]+)\)$/u.exec(piece) ?? [];
      return webLink(url) ? `<a href="${url}">${emphasis(label)}</a>` : emphasis(label);
    })
    .join("");
}

/** A link the phone could open. Core separately checks whether Auni has a phone address. */
export function webLink(value: string): boolean {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return Boolean(
    host.includes(".") &&
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    !host.startsWith("127.") &&
    host !== "0.0.0.0",
  );
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*\n]+?)\*\*/gu, "<b>$1</b>")
    .replace(/__([^_\n]+?)__/gu, "<b>$1</b>")
    .replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/gmu, "$1<i>$2</i>")
    .replace(/~~([^~\n]+?)~~/gu, "<s>$1</s>");
}

/** A long answer as several messages, cut where a paragraph, line or word ends. */
export function chunks(text: string, max = MESSAGE_CHARS): string[] {
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
