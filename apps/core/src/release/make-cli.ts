import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { makeRelease, publishRelease, ReleaseNotMade } from "./make.ts";

// `pnpm release --notes <file> --key <public key> [--dry-run]` (RELEASING.md). Makes the release
// in .release/ at the repo root and checks it; then, unless --dry-run, asks before publishing.

const ROOT = resolve(import.meta.dirname, "../../../..");
const usage =
  "Usage: pnpm release --notes <file> [--key <public key>] [--dry-run]\n" +
  "The key may be set as AUNI_RELEASE_KEY instead (RELEASING.md).";

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        notes: { type: "string" },
        key: { type: "string" },
        "dry-run": { type: "boolean" },
      },
    });
  } catch {
    console.error(usage);
    process.exit(2);
  }
})();
const key = values.key ?? process.env.AUNI_RELEASE_KEY;
if (!values.notes || !key) {
  console.error(usage);
  process.exit(2);
}

try {
  const made = makeRelease({
    root: ROOT,
    notes: readFileSync(values.notes, "utf8"),
    key: resolve(key),
    out: resolve(ROOT, ".release"),
  });
  const { tag, dir } = made;
  console.log(`${tag} is made and checked, in ${dir}.`);
  if (values["dry-run"]) {
    console.log("Nothing was tagged, pushed or published.");
    process.exit(0);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(
    `Publish ${tag}? Every Auni will offer it, and a published release can't be changed. [y/N] `,
  );
  terminal.close();
  if (!/^y(es)?$/iu.test(answer.trim())) {
    console.log("Nothing was published.");
    process.exit(0);
  }
  publishRelease(made);
  console.log(`${tag} is published.`);
} catch (error) {
  if (!(error instanceof ReleaseNotMade)) throw error;
  console.error(error.message);
  process.exit(1);
}
