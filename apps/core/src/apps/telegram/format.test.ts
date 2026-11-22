import { describe, expect, it } from "vitest";

import { chunks, toHtml } from "./format.ts";

describe("toHtml", () => {
  it("turns the agent's markdown into Telegram's tags", () => {
    expect(toHtml("## Plan\n**Buy** some *chips*, see [NVDA](https://nvidia.com) ~~now~~")).toBe(
      '<b>Plan</b>\n<b>Buy</b> some <i>chips</i>, see <a href="https://nvidia.com">NVDA</a> <s>now</s>',
    );
  });

  it("escapes everything else, so no text adds a tag of its own", () => {
    expect(toHtml('<a href="x">5 < 6 & "7"</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;5 &lt; 6 &amp; &quot;7&quot;&lt;/a&gt;",
    );
  });

  it("keeps code as written", () => {
    expect(toHtml("run `pnpm **pair**` or\n```bash\necho <hi>\n```")).toBe(
      "run <code>pnpm **pair**</code> or\n<pre>echo &lt;hi&gt;</pre>",
    );
  });

  it("shows a mark after a backslash as itself, so escaped words can't format", () => {
    expect(toHtml("**Buy \\[Claim\\](https://evil.example) \\*\\*FREE\\*\\* \\<b\\>**")).toBe(
      "<b>Buy [Claim](https://evil.example) **FREE** &lt;b&gt;</b>",
    );
    expect(toHtml("a \\`code\\` b \\\\ c")).toBe("a `code` b \\ c");
  });

  it("leaves a lone star, a snake_case name and a list alone", () => {
    expect(toHtml("- 2 * 3 is six\n- my_wallet_name")).toBe("- 2 * 3 is six\n- my_wallet_name");
  });
});

describe("chunks", () => {
  it("keeps a short answer whole", () => {
    expect(chunks("  Hello  ")).toEqual(["Hello"]);
  });

  it("cuts a long one where a paragraph ends", () => {
    const first = "a".repeat(60);
    const second = "b".repeat(30);
    expect(chunks(`${first}\n\n${second}`, 80)).toEqual([first, second]);
  });

  it("cuts a word that is too long anywhere", () => {
    expect(chunks("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});
