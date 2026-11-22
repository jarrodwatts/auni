// A release's release.txt: the one file a release key signs (`pnpm release` writes it, install.sh
// checks it). Its first lines name what the release is, one `<field> <value>` a line; after a
// blank line come its notes, what changed, in plain words for the owner:
//
//   version v0.2.0
//   made 2026-11-12T10:00:00Z
//   commit 691dcde58c1f...        the commit its source was archived from
//   source 3a5f...                the SHA-256 of its source.tar.gz
//
//   Limit orders can be cancelled from their card...
//
// install.sh reads the same fields with sed, so the format stays this plain.

import { isReleaseTag } from "./tags.ts";

export interface Release {
  /** Its tag: "v0.2.0". */
  readonly version: string;
  /** When `pnpm release` made it, in UTC: "2026-11-12T10:00:00Z". */
  readonly made: string;
  readonly commit: string;
  /** The SHA-256 of its source.tar.gz, in hex. */
  readonly source: string;
  /** What changed, in plain words. */
  readonly notes: string;
}

const FIELDS = ["version", "made", "commit", "source"] as const;

export function writeRelease(release: Release): string {
  const head = FIELDS.map((field) => `${field} ${release[field]}`).join("\n");
  return `${head}\n\n${release.notes.trim()}\n`;
}

/** Reads a release.txt, throwing when it isn't one. */
export function readRelease(text: string): Release {
  const blank = text.indexOf("\n\n");
  const head = blank === -1 ? text : text.slice(0, blank);
  const fields = new Map(
    head
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
  );
  const [version, made, commit, source] = FIELDS.map((field) => fields.get(field) ?? "");
  if (
    !isReleaseTag(version!) ||
    Number.isNaN(Date.parse(made!)) ||
    !/^[0-9a-f]{64}$/u.test(source!)
  )
    throw new Error("This isn't a release.txt.");
  return {
    version: version!,
    made: made!,
    commit: commit!,
    source: source!,
    notes: blank === -1 ? "" : text.slice(blank + 2).trim(),
  };
}
