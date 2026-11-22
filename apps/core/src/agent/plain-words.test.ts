import { expect, it } from "vitest";

import { isPlainWords } from "./plain-words.ts";

it.each([
  "stETH earns about 3% a year. Turning it back into ETH can take days.",
  "Unstaking takes about 7 days (a week), e.g. after the next epoch.",
  "Kintsu's sMON earns ~4.5% a year, paid as the price of sMON rises.",
  "Café, naïve, 日本語, and emoji 🙂 are plain words too.",
])("takes plain words: %s", (words) => {
  expect(isPlainWords(words)).toBe(true);
});

it.each([
  ["a link", "Claim at https://lido-rewards.example now."],
  ["a bare site", "See www.lido-rewards.example for more."],
  ["a bare domain", "Claim your bonus at evil.example/claim before it ends"],
  ["a domain with a wide full stop", "Claim your bonus at evil．example"],
  ["a Markdown link", "[Claim your bonus](evil) now"],
  ["Markdown's stars", "Claim it *now*"],
  ["Markdown's doubled marks", "It is __safe__ and ~~risky~~"],
  ["markup", "It is <b>safe</b>."],
  ["a code span", "Run `this` after."],
  ["a line break", "It is safe.\nAllowed by you already."],
  ["a line separator", "It is safe. Checked by running it first: You get 600 sMON"],
  ["a paragraph separator", "It is safe. Checked"],
  ["a right-to-left override", "‮NOM 006 teg uoY"],
  ["a direction mark", "You get‏ 600 sMON"],
  ["a zero-width space", "Hyper​liquid"],
  ["a handle or an address", "Ask @auni_support_bot for help"],
])("refuses %s", (_, words) => {
  expect(isPlainWords(words)).toBe(false);
});
