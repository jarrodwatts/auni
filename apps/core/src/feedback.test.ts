import { readFileSync } from "node:fs";

import {
  FEEDBACK_KINDS,
  FEEDBACK_URL_LIMIT,
  feedbackPost,
  feedbackSearchUrl,
  type Feedback,
} from "@auni/shared";
import { describe, expect, it } from "vitest";

import { scrub } from "./feedback.ts";

// What leaves the owner's machine when they post feedback: the address the button opens and the
// words core lets into it.

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const request: Feedback = {
  kind: "app",
  heading: "Ask for a Lido app",
  why: "An app would make this read better.",
  title: "App request: Lido",
  search: "Lido",
  always: [
    { field: "service", label: "The service", value: "Lido" },
    { field: "asked", label: "What you asked for", value: "Stake ETH with Lido" },
  ],
  optional: [
    {
      field: "steps",
      label: "The steps that worked",
      value: "On Ethereum: called 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84 with 0xa1903eab.",
      warning: "Posted this soon after, they can show which wallet is yours.",
    },
    {
      field: "transaction",
      label: "The transaction link",
      value: "https://etherscan.io/tx/0xabc",
      warning: "This shows your wallet address beside your GitHub name.",
    },
  ],
};

const fieldsOf = (url: string) => new URL(url).searchParams;

describe("the address a feedback card opens", () => {
  it("is always a new issue on Auni's own repository, whatever the card says", () => {
    const hostile: Feedback = {
      ...request,
      title: "x&template=evil.yml#https://evil.example/",
      always: [{ field: "service", label: "The service", value: "https://evil.example/?a=b&c=d" }],
    };
    for (const feedback of [request, hostile]) {
      const url = new URL(feedbackPost(feedback, new Set(["steps", "transaction"])).url);
      expect(`${url.origin}${url.pathname}`).toBe("https://github.com/jarrodwatts/auni/issues/new");
      expect(url.hash).toBe("");
      expect(url.searchParams.getAll("template")).toEqual(["app.yml"]);
    }
    expect(feedbackSearchUrl(request)).toBe(
      "https://github.com/jarrodwatts/auni/issues?q=is%3Aissue+Lido",
    );
  });

  it("fills each part into the form's field of its name, and the whole again as data", () => {
    const fields = fieldsOf(feedbackPost(request, new Set()).url);
    expect(fields.get("title")).toBe("App request: Lido");
    expect(fields.get("service")).toBe("Lido");
    expect(fields.get("asked")).toBe("Stake ETH with Lido");
    expect(JSON.parse(fields.get("details")!)).toEqual({
      kind: "app",
      title: "App request: Lido",
      service: "Lido",
      asked: "Stake ETH with Lido",
    });
  });

  it("carries nothing optional unless it is ticked, in the address or in the text", () => {
    const bare = feedbackPost(request, new Set());
    expect(fieldsOf(bare.url).has("steps")).toBe(false);
    expect(fieldsOf(bare.url).has("transaction")).toBe(false);
    expect(bare.url).not.toContain("ae7ab");
    expect(bare.url).not.toContain("etherscan");
    expect(bare.text).not.toContain("0xae7a");
    expect(bare.text).not.toContain("etherscan");

    const steps = feedbackPost(request, new Set(["steps"]));
    expect(fieldsOf(steps.url).get("steps")).toContain("0xa1903eab");
    expect(steps.url).not.toContain("etherscan");
    // A tick for something the card never offered posts nothing.
    expect(feedbackPost(request, new Set(["balance"])).url).toBe(bare.url);
  });

  it("stays under the limit by cutting the longest part, and Copy still gives all of it", () => {
    const long = "called 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84 with 0xa1903eab.\n".repeat(60);
    const feedback: Feedback = {
      ...request,
      optional: [{ ...request.optional[0]!, value: long.trim() }],
    };
    const post = feedbackPost(feedback, new Set(["steps"]));
    expect(post.url.length).toBeLessThanOrEqual(FEEDBACK_URL_LIMIT);
    expect(post.cut).toBe(true);
    expect(fieldsOf(post.url).get("steps")!.endsWith("…")).toBe(true);
    expect(fieldsOf(post.url).get("service")).toBe("Lido");
    expect(post.text).toContain(long.trim());
    // One that fits is left whole.
    expect(feedbackPost(request, new Set(["steps"])).cut).toBe(false);
  });
});

describe("words core lets into feedback", () => {
  it("cuts a link down to its site, so a node's address never posts its key", () => {
    const error =
      'HTTP request failed. URL: https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161 Request body: {"method":"eth_call"}';
    expect(scrub(error)).toBe(
      'HTTP request failed. URL: mainnet.infura.io Request body: {"method":"eth_call"}',
    );
    expect(scrub("wss://solana-mainnet.quiknode.pro/abcdef0123456789/ refused")).toBe(
      "solana-mainnet.quiknode.pro refused",
    );
    // The stop after a link is the sentence's.
    expect(scrub("see https://user:hunter2@rpc.example.org:8545/path?key=s3cret.")).toBe(
      "see rpc.example.org.",
    );
    // However the link is written: escaped as JSON escapes it, or with no scheme at all.
    expect(scrub('{"url":"https:\\/\\/rpc.ankr.com\\/base\\/ANKRKEY0123"}')).toBe(
      '{"url":"rpc.ankr.com"}',
    );
    expect(scrub("asked rpc.quiknode.pro/QNKEY0123/ and node.example:8545/x")).toBe(
      "asked rpc.quiknode.pro and node.example",
    );
  });

  it("blanks a key, a token or a secret, by its name or by its shape", () => {
    expect(scrub("x-api-key: JUPKEY-abcdef, Authorization: Bearer eyJhbGciOi.e30.abc")).toBe(
      "x-api-key: …, Authorization: …",
    );
    expect(scrub('{"apiKey":"s3cr3t","error":"Unknown token"}')).toBe(
      '{"apiKey":"…","error":"Unknown token"}',
    );
    expect(scrub("Unauthorized for bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(
      "Unauthorized for bot …",
    );
    expect(scrub("invalid key ak_live_9f8e7d6c5b4a39281706f5e4 for this plan")).toBe(
      "invalid key … for this plan",
    );
  });

  it("blanks anything shaped like an address or a hash, the owner's among them", () => {
    const scrubbed = scrub(
      `transfer from ${OWNER} to ${OWNER.toLowerCase()} in 0x${"ab".repeat(32)} by JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n`,
    );
    expect(scrubbed).toBe("transfer from 0x… to 0x… in 0x… by …");
    expect(scrubbed).not.toMatch(/0x[0-9a-f]{40}/iu);
    // And without its "0x", padded as an argument is or not.
    const bare = OWNER.slice(2);
    expect(scrub(`args ${bare} and ${bare.padStart(64, "0")}`)).toBe("args … and …");
    // A function's selector and a panic's code say what broke and point at nobody.
    expect(scrub("reverted with 0x47bc4b2c (panic 0x11)")).toBe(
      "reverted with 0x47bc4b2c (panic 0x11)",
    );
  });

  it("blanks amounts, and keeps the numbers that say what went wrong", () => {
    expect(scrub("holds only 12.5 USDC, needs $1,250.00 or 1250000000 units")).toBe(
      "holds only # USDC, needs # or # units",
    );
    expect(scrub("Sell 500 stETH for 3 WETH")).toBe("Sell # stETH for # WETH");
    expect(scrub("Call 2 of 2 reverts (HTTP 429)")).toBe("Call 2 of 2 reverts (HTTP 429)");
    expect(scrub("Status: 401\nURL: x")).toBe("Status: 401\nURL: x");
  });
});

describe("the issue forms", () => {
  const template = (kind: string) =>
    readFileSync(new URL(`../../../.github/ISSUE_TEMPLATE/${kind}.yml`, import.meta.url), "utf8");
  /** Each field of a form: its id and its type. */
  const fieldsIn = (form: string) =>
    new Map(
      [...form.matchAll(/- type: (\w+)\n\s+id: ([\w-]+)/gu)].map(([, type, id]) => [id!, type!]),
    );

  // What feedback.ts may put in each kind's parts: a part with no field in its form is dropped
  // by GitHub without a word.
  const PARTS: Record<(typeof FEEDBACK_KINDS)[number], readonly string[]> = {
    app: ["service", "site", "asked", "chain", "steps", "transaction"],
    bug: ["happened", "app", "tool", "failure", "said", "tries", "version", "error", "transaction"],
    idea: ["idea", "version"],
  };

  it.each(FEEDBACK_KINDS)("the %s form has a text field for each part and for the data", (kind) => {
    const fields = fieldsIn(template(kind));
    for (const id of [...PARTS[kind], "details"]) {
      // GitHub fills only text fields from an address (its docs: "custom text fields").
      expect(["input", "textarea"], `${kind}.yml ${id}`).toContain(fields.get(id));
    }
    expect([...fields.keys()].sort()).toEqual([...PARTS[kind], "details"].sort());
  });

  it("names every part feedback.ts builds", () => {
    const source = readFileSync(new URL("./feedback.ts", import.meta.url), "utf8");
    const built = new Set([...source.matchAll(/field: "([a-z-]+)"/gu)].map(([, id]) => id!));
    expect([...built].sort()).toEqual([...new Set(Object.values(PARTS).flat())].sort());
  });
});
