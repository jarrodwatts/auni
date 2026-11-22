import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRelease, writeRelease } from "./manifest.ts";
import { byRelease, isReleaseTag } from "./tags.ts";

// `pnpm release`: makes a release of the commit checked out, on the project owner's machine, as
// RELEASING.md says. A release is three files (install.sh says what each is):
//
//   check: main, clean, the same as origin's; its version newer than every release; the key one
//     install.sh lists -> source.tar.gz (git archive) -> release.txt -> release.txt.sig (the key)
//     -> install.sh from that source checks the three as an owner's Auni will   (makeRelease)
//     -> a signed tag, pushed, and a GitHub release holding the three files      (publishRelease)
//
// The signature is the proof; GitHub only carries it, so the key never goes near GitHub.

/** Why no release was made, in words for whoever is releasing. */
export class ReleaseNotMade extends Error {}

export interface Made {
  readonly root: string;
  readonly key: string;
  readonly tag: string;
  readonly commit: string;
  /** The folder holding the three files: `<out>/download/<tag>`, laid out as GitHub serves them. */
  readonly dir: string;
}

const gitIn =
  (root: string) =>
  (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

/**
 * Makes the release of `root`'s checked-out commit into `out`, signed with `key` (a public key
 * whose private half ssh-keygen can use: beside it, or in an agent), and checks it. Throws
 * ReleaseNotMade, having changed nothing but `out`, when it can't.
 */
export function makeRelease({
  root,
  notes,
  key,
  out,
}: {
  readonly root: string;
  readonly notes: string;
  readonly key: string;
  readonly out: string;
}): Made {
  const git = gitIn(root);

  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const tag = `v${version}`;
  if (!isReleaseTag(tag))
    throw new ReleaseNotMade(`package.json's version is ${version}, not one such as 0.2.0.`);
  if (git("status", "--porcelain"))
    throw new ReleaseNotMade("This checkout has changes: commit them or put them aside first.");
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main")
    throw new ReleaseNotMade("A release is made from main: check it out first.");
  git("fetch", "--quiet", "origin", "main");
  const commit = git("rev-parse", "HEAD");
  if (commit !== git("rev-parse", "origin/main"))
    throw new ReleaseNotMade("main here isn't origin's main: pull or push first.");
  const released = git("ls-remote", "--tags", "origin")
    .split("\n")
    .map((line) => line.replace(/^.*refs\/tags\//u, "").replace(/\^\{\}$/u, ""))
    .filter(isReleaseTag);
  if (released.includes(tag) || git("tag", "--list", tag))
    throw new ReleaseNotMade(
      `${tag} is released already: raise the version in package.json first.`,
    );
  const newest = released.sort(byRelease).at(-1);
  if (newest && byRelease(tag, newest) < 0)
    throw new ReleaseNotMade(`${tag} is older than ${newest}, the newest release.`);
  if (!notes.trim())
    throw new ReleaseNotMade("Say what changed, in plain words: the notes are what owners read.");
  const listed = releaseKeys(readFileSync(join(root, "install.sh"), "utf8"));
  const [type, base64] = readFileSync(key, "utf8").trim().split(/\s+/u);
  if (!listed.includes(`${type} ${base64}`))
    throw new ReleaseNotMade(
      `${key} isn't a release key install.sh lists, so no Auni would take what it signs. RELEASING.md says how a key is added.`,
    );

  const dir = join(out, "download", tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.tar.gz");
  git("archive", "--format=tar.gz", "--prefix=auni/", "-o", source, commit);
  const manifest = join(dir, "release.txt");
  writeFileSync(
    manifest,
    writeRelease({
      version: tag,
      made: new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
      commit,
      source: createHash("sha256").update(readFileSync(source)).digest("hex"),
      notes,
    }),
  );
  const signed = spawnSync(
    "ssh-keygen",
    ["-Y", "sign", "-q", "-f", key, "-n", "auni-release", manifest],
    {
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (signed.status !== 0) throw new ReleaseNotMade(`ssh-keygen couldn't sign with ${key}.`);
  selfCheck(out, tag, source, readFileSync(manifest, "utf8"));
  return { root, key, tag, commit, dir };
}

/** Publishes a release makeRelease made: a signed tag, pushed, and a GitHub release of its files. */
export function publishRelease({ root, key, tag, commit, dir }: Made): void {
  const git = gitIn(root);
  // The tag is signed too, with the same key: GitHub shows it as verified to whoever looks.
  git(
    "-c",
    "gpg.format=ssh",
    "-c",
    `user.signingKey=${key}`,
    "tag",
    "-s",
    tag,
    "-m",
    `Auni ${tag}`,
    commit,
  );
  git("push", "--quiet", "origin", `refs/tags/${tag}`);
  const notes = join(dir, "notes.md");
  writeFileSync(notes, readRelease(readFileSync(join(dir, "release.txt"), "utf8")).notes);
  const gh = (...args: string[]) => execFileSync("gh", args, { cwd: root, stdio: "inherit" });
  // A draft first, its files attached, then published: an immutable release locks what it holds
  // the moment it's published.
  gh(
    "release",
    "create",
    tag,
    "--verify-tag",
    "--draft",
    "--title",
    `Auni ${tag}`,
    "--notes-file",
    notes,
    ...["source.tar.gz", "release.txt", "release.txt.sig"].map((file) => join(dir, file)),
  );
  gh("release", "edit", tag, "--draft=false", "--latest");
}

/** The keys install.sh's RELEASE_KEYS block lists as signing now: "ssh-ed25519 AAAA...". */
export function releaseKeys(installer: string): string[] {
  const block = /^RELEASE_KEYS='([^']*)'/mu.exec(installer)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter(([principal]) => principal === "auni-release")
    .map((fields) => fields.slice(-2).join(" "));
}

/**
 * Runs the installer the release itself carries, checking only, over the files just made, as an
 * owner's Auni will check them: anything it would refuse is never published.
 */
function selfCheck(out: string, tag: string, source: string, manifest: string): void {
  const scratch = mkdtempSync(join(tmpdir(), "auni-release-"));
  try {
    execFileSync("tar", ["-xzf", source, "-C", scratch, "--strip-components=1", "auni/install.sh"]);
    const checked = spawnSync("sh", [join(scratch, "install.sh")], {
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        AUNI_HOME: join(scratch, "home"),
        AUNI_CHECK: "1",
        AUNI_VERSION: tag,
        AUNI_RELEASES: `file://${out}`,
      },
      encoding: "utf8",
    });
    if (
      checked.status !== 0 ||
      readRelease(checked.stdout).version !== tag ||
      checked.stdout !== manifest
    )
      throw new ReleaseNotMade(`install.sh refused the release: ${checked.stderr.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
