/**
 * Names as a sentence lists them, for core and the web alike: "one", "one and two", "one, two
 * and three", or with "or", "Monad, Base or Solana".
 */
export function listed(names: readonly string[], joined: "and" | "or" = "and"): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} ${joined} ${names.at(-1)}`;
}

/** Two letters a spoken English word can start with, before a vowel: "SPY", "TRUMP", "FLOKI". */
const ONSET =
  /^(BL|BR|CH|CL|CR|DR|FL|FR|GL|GR|PH|PL|PR|SC|SH|SK|SL|SM|SN|SP|ST|SW|TH|TR|TW|WH|WR)[AEIOUY]/u;

/**
 * A name with "a" or "an" before it, chosen by how the name sounds said aloud, since a name is
 * often a ticker: "an ETH short", "a BTC long", "an NVDA short", "an Arbitrum address", "a
 * Uniswap app", "an 8x long". A ticker said as a word (SOL, HYPE) starts with its first sound; one
 * said letter by letter (BTC, XRP) with the name of its first letter.
 */
export function withArticle(name: string): string {
  return `${anBefore(name) ? "an" : "a"} ${name}`;
}

function anBefore(name: string): boolean {
  // Eight, eleven, eighteen, eighty: the numbers whose words start with a vowel.
  if (/^\d/u.test(name)) return /^(8|1[18](?![\d,.]*\d))/u.test(name);
  const word = /^[A-Za-z]+/u.exec(name)?.[0] ?? "";
  if (word.length > 1 && word === word.toUpperCase()) {
    const spoken = /^[AEIOU]|^[^AEIOU][AEIOUY]/u.test(word) || ONSET.test(word);
    // A word starting with U is said "you" (UNI); a letter's name, "ef", "aitch", "em".
    return spoken ? /^[AEIO]/u.test(word) : /^[AEFHILMNORSX]/u.test(word);
  }
  // A u said "you" (Uniswap, Unichain, Usual) takes "a", as does "one"; an unsaid h takes "an".
  if (/^(u[^aeiou\W][aeiou]|one\b)/iu.test(word)) return false;
  return /^([aeiou]|hour|honest|heir)/iu.test(word);
}

/**
 * `text` cut at a word to fit `max` characters, with an ellipsis when it was cut, so a title is
 * never cut mid-word: "...than the portfolio's cash…", never "...cash tot".
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/u, "")}…`;
}
