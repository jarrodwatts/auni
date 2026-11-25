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

  it("uses bullets and leaves a lone star and a snake_case name alone", () => {
    expect(toHtml("- 2 * 3 is six\n- my_wallet_name")).toBe("• 2 * 3 is six\n• my_wallet_name");
  });
  it("shows quotes as one block and leaves fenced data alone", () => {
    expect(toHtml("Intro\n> **Buy**\n> 50 USDC\n\nEnd")).toBe(
      "Intro\n<blockquote><b>Buy</b>\n50 USDC</blockquote>\n\nEnd",
    );
    expect(toHtml("```\n> Quote\n| A | B |\n```")).toBe("<pre>&gt; Quote\n| A | B |</pre>");
  });

  it("lays out table rows one at a time on a phone", () => {
    expect(toHtml("| Asset | Fee |\n| :--- | ---: |\n| ETH | $5 |\n| SOL | $1 |")).toBe(
      "Asset: ETH\nFee: $5\n\nAsset: SOL\nFee: $1",
    );
  });

  it("keeps a table compact when repeating its headings would exceed the message budget", () => {
    const table = [
      `| ${"Header".repeat(50)} | Fee |`,
      "| --- | --- |",
      ...Array(20).fill("| ETH | $5 |"),
    ].join("\n");
    expect(toHtml(table)).toBe(table);
  });

  it("leaves links to localhost and loopback addresses as labels alone", () => {
    expect(toHtml("[Open Auni](http://localhost:3000) or [open](https://127.0.0.1)")).toBe(
      "Open Auni or open",
    );
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
