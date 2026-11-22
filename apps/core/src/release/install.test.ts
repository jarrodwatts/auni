import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReleaseRefused, sourceTag } from "./check.ts";
import { makeRelease, publishRelease, ReleaseNotMade, releaseKeys, type Made } from "./make.ts";
import { readRelease } from "./manifest.ts";

// install.sh, run for real, against releases `pnpm release` really made: a bare git repository
// stands in for GitHub's, a folder laid out as GitHub serves release files stands in for its
// releases, and throwaway keys stand in for the project owner's. Each attack is one an owner's
// Auni must refuse, in words the owner understands.

const INSTALLER = readFileSync(resolve(import.meta.dirname, "../../../../install.sh"), "utf8");

let scratch: string;
let repo: string;
let releases: string;
let first: Made;
const key = (name: string) => join(scratch, "keys", `${name}.pub`);
const line = (name: string) =>
  readFileSync(key(name), "utf8").trim().split(" ").slice(0, 2).join(" ");

/** install.sh with its own RELEASE_KEYS block in place of the one the repo ships. */
function installerWith(block: readonly string[]): string {
  return INSTALLER.replace(/^RELEASE_KEYS='[^']*'/mu, `RELEASE_KEYS='\n${block.join("\n")}\n'`);
}

/** install.sh as a version carries it, listing these tests' throwaway release keys by name. */
function installerListing(keys: { readonly signing: string; readonly retired?: string }): string {
  const block = [`auni-release namespaces="auni-release" ${line(keys.signing)}`];
  if (keys.retired) block.push(`retired namespaces="auni-release" ${line(keys.retired)}`);
  return installerWith(block);
}

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function commitVersion(
  version: string,
  installer = installerListing({ signing: "owner", retired: "old" }),
) {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "auni", version }, null, 2));
  writeFileSync(join(repo, "install.sh"), installer);
  git("add", "-A");
  git("commit", "--quiet", "-m", `Auni v${version}`);
  git("push", "--quiet", "origin", "main");
}

/** A copy of the releases folder, changed by `change`, where `latest` is `newest`. */
function releasesWith(newest: string, change: (download: string) => void = () => {}): string {
  const copy = mkdtempSync(join(scratch, "releases-"));
  cpSync(join(releases, "download"), join(copy, "download"), { recursive: true });
  mkdirSync(join(copy, "latest"));
  symlinkSync(join(copy, "download", newest), join(copy, "latest", "download"));
  change(join(copy, "download"));
  return copy;
}

/** install.sh (the stand-in repo's, unless named), checking only unless `full`. */
function install(
  from: string,
  {
    version,
    current,
    full,
    installer = join(repo, "install.sh"),
  }: {
    version?: string;
    current?: string;
    full?: boolean;
    installer?: string;
  } = {},
) {
  const home = mkdtempSync(join(scratch, "home-"));
  if (current) {
    mkdirSync(join(home, "app/versions", current), { recursive: true });
    symlinkSync(join("versions", current), join(home, "app/current"));
  }
  const ran = spawnSync("sh", [installer], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      AUNI_HOME: home,
      AUNI_RELEASES: `file://${from}`,
      ...(full ? {} : { AUNI_CHECK: "1" }),
      ...(version ? { AUNI_VERSION: version } : {}),
    },
    encoding: "utf8",
  });
  return { code: ran.status, out: ran.stdout, said: ran.stderr.trim() };
}

function sign(file: string, name: string) {
  rmSync(`${file}.sig`, { force: true });
  execFileSync(
    "ssh-keygen",
    ["-Y", "sign", "-q", "-f", join(scratch, "keys", name), "-n", "auni-release", file],
    {
      stdio: "ignore",
    },
  );
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "auni-release-test-"));
  mkdirSync(join(scratch, "keys"));
  for (const name of ["owner", "old", "stranger"])
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      name,
      "-f",
      join(scratch, "keys", name),
    ]);
  const github = join(scratch, "github.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", github]);
  repo = join(scratch, "repo");
  execFileSync("git", ["clone", "--quiet", github, repo], { stdio: "ignore" });
  git("config", "user.email", "owner@example.com");
  git("config", "user.name", "Owner");
  git("checkout", "--quiet", "-b", "main");
  writeFileSync(join(repo, ".node-version"), "24.22.2\n");
  commitVersion("0.1.0");
  releases = join(scratch, "releases");
  first = makeRelease({
    root: repo,
    notes: "The first release.",
    key: key("owner"),
    out: releases,
  });
  // `gh` as GitHub's CLI would be called, writing down what it was asked.
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(scratch, "gh-calls")}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    publishRelease(first);
  } finally {
    process.env.PATH = path;
  }
}, 60_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a release", { timeout: 30_000 }, () => {
  it("is three files, which install.sh takes, printing the release it checked", () => {
    const checked = install(releasesWith("v0.1.0"));
    expect(checked).toMatchObject({ code: 0, said: "" });
    const release = readRelease(checked.out);
    expect(release).toMatchObject({
      version: "v0.1.0",
      commit: git("rev-parse", "HEAD"),
      notes: "The first release.",
    });
    expect(release.source).toBe(
      createHash("sha256")
        .update(readFileSync(join(first.dir, "source.tar.gz")))
        .digest("hex"),
    );
  });

  it("is published as a signed tag on the repository and a release of its three files", () => {
    expect(
      execFileSync(
        "git",
        ["--git-dir", join(scratch, "github.git"), "rev-parse", "v0.1.0^{commit}"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe(first.commit);
    const allowed = join(scratch, "allowed");
    writeFileSync(allowed, `owner@example.com ${line("owner")}\n`);
    execFileSync("git", ["-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-tag", "v0.1.0"], {
      cwd: repo,
      stdio: "ignore",
    });
    const calls = readFileSync(join(scratch, "gh-calls"), "utf8").trim().split("\n");
    expect(calls[0]).toMatch(
      /^release create v0\.1\.0 --verify-tag --draft .*source\.tar\.gz .*release\.txt .*release\.txt\.sig$/u,
    );
    expect(calls[1]).toBe("release edit v0.1.0 --draft=false --latest");
  });

  it("is refused when its release.txt was changed after it was signed", () => {
    const changed = releasesWith("v0.1.0", (download) => {
      const file = join(download, "v0.1.0/release.txt");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("The first release.", "Nothing to see."),
      );
    });
    expect(install(changed)).toMatchObject({
      code: 1,
      said: "release v0.1.0 isn't signed by Auni's release key: its release.txt was changed after it was signed, or someone else signed it.",
    });
  });

  it("is refused when it has no signature", () => {
    const unsigned = releasesWith("v0.1.0", (download) =>
      rmSync(join(download, "v0.1.0/release.txt.sig")),
    );
    expect(install(unsigned)).toMatchObject({
      code: 1,
      said: "release v0.1.0 has no signature, so nothing shows it is a release Auni's owner made.",
    });
  });

  it("is refused when someone else's key signed it", () => {
    const forged = releasesWith("v0.1.0", (download) =>
      sign(join(download, "v0.1.0/release.txt"), "stranger"),
    );
    expect(install(forged).said).toBe(
      "release v0.1.0 isn't signed by Auni's release key: its release.txt was changed after it was signed, or someone else signed it.",
    );
  });

  it("is refused, by name, when a retired key signed it", () => {
    const retired = releasesWith("v0.1.0", (download) =>
      sign(join(download, "v0.1.0/release.txt"), "old"),
    );
    expect(install(retired)).toMatchObject({
      code: 1,
      said: "release v0.1.0 is signed with a release key that has been retired, so it isn't a release Auni makes any more.",
    });
  });

  it("is refused when it is older than what's installed but offered as the newest", () => {
    expect(install(releasesWith("v0.1.0"), { current: "v0.2.0" })).toMatchObject({
      code: 1,
      said: "the newest release offered is v0.1.0, older than v0.2.0 installed here, so it wasn't used.",
    });
    // Named, it is the owner going back on purpose.
    expect(install(releasesWith("v0.1.0"), { current: "v0.2.0", version: "v0.1.0" }).code).toBe(0);
  });

  it("is refused when it is offered under another release's name", () => {
    const swapped = releasesWith("v0.1.0", (download) =>
      cpSync(join(download, "v0.1.0"), join(download, "v0.3.0"), { recursive: true }),
    );
    expect(install(swapped, { version: "v0.3.0" })).toMatchObject({
      code: 1,
      said: "the release fetched as v0.3.0 says it is v0.1.0, so it wasn't used.",
    });
  });

  it("installs nothing when its download isn't the source it names, as when its tag is moved", () => {
    // Whoever holds the GitHub account moves the tag to their own commit, and makes the release's
    // source again from where it now points. Its release.txt, which they can't sign, still names
    // the source that was released.
    writeFileSync(join(repo, "planted.ts"), "export const planted = true;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "planted");
    git("tag", "-f", "v0.1.0");
    git("push", "--quiet", "--force", "origin", "refs/tags/v0.1.0", "main");
    const moved = releasesWith("v0.1.0", (download) =>
      git(
        "archive",
        "--format=tar.gz",
        "--prefix=auni/",
        "-o",
        join(download, "v0.1.0/source.tar.gz"),
        "v0.1.0",
      ),
    );
    const installed = install(moved, { full: true });
    expect(installed.code).toBe(1);
    expect(installed.said).toBe(
      "Auni was not installed: the source downloaded for v0.1.0 isn't the one its release names (its SHA-256 differs), so it wasn't used.",
    );
    git("reset", "--quiet", "--hard", "HEAD~1");
    git("push", "--quiet", "--force", "origin", "main");
  });

  it("can't be checked by an installer that lists no release key", () => {
    const bare = join(scratch, "bare-install.sh");
    writeFileSync(bare, installerWith([]));
    expect(install(releasesWith("v0.1.0"), { installer: bare }).said).toBe(
      "this installer lists no release key yet, so no release can be checked. AUNI_SOURCE builds source you name.",
    );
  });
});

describe("pnpm release", { timeout: 30_000 }, () => {
  const made = (keyName = "owner") =>
    makeRelease({ root: repo, notes: "Next.", key: key(keyName), out: join(scratch, "made") });

  it("refuses a version that is released already, or a key install.sh doesn't list", () => {
    expect(made).toThrow(
      new ReleaseNotMade("v0.1.0 is released already: raise the version in package.json first."),
    );
    commitVersion("0.1.1");
    expect(() => made("stranger")).toThrow(/stranger\.pub isn't a release key install\.sh lists/u);
    expect(() => made("old")).toThrow(ReleaseNotMade);
    expect(made().tag).toBe("v0.1.1");
  });

  it("refuses a checkout with changes, or one that isn't origin's main", () => {
    writeFileSync(join(repo, "loose.txt"), "not committed\n");
    expect(made).toThrow("This checkout has changes: commit them or put them aside first.");
    rmSync(join(repo, "loose.txt"));
    writeFileSync(join(repo, "local.txt"), "\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "not pushed");
    expect(made).toThrow("main here isn't origin's main: pull or push first.");
    git("reset", "--quiet", "--hard", "HEAD~1");
  });

  it("lists only the keys that sign now, never a retired one", () => {
    expect(releaseKeys(installerListing({ signing: "owner", retired: "old" }))).toEqual([
      line("owner"),
    ]);
  });

  it("ships with exactly the project owner's two keys, the ones published in DNS", () => {
    // `dig +short TXT _auni-release.auni.io` answers these: the release key and its backup.
    const fingerprints = releaseKeys(INSTALLER).map(
      (listed) =>
        execFileSync("ssh-keygen", ["-lf", "-"], { input: `${listed}\n`, encoding: "utf8" }).split(
          " ",
        )[1],
    );
    expect(fingerprints).toEqual([
      "SHA256:c8utSSyxGQjj8K1xGhb1xkgE9ig9lI+p721qru7jZWQ",
      "SHA256:mEefqOCVrBeQSokn/s7rlcyV62QRsG7aTonm5SruiOA",
    ]);
  });
});

describe("a source's version", () => {
  /** A tarball of source whose package.json says `version`, as `git archive --prefix=auni/` makes. */
  function sourceTarball(version: string): string {
    const tree = mkdtempSync(join(scratch, "source-"));
    mkdirSync(join(tree, "auni"));
    writeFileSync(
      join(tree, "auni/package.json"),
      JSON.stringify({ name: "auni", version }, null, 2),
    );
    const tarball = join(tree, "auni.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", tree, "auni"]);
    return tarball;
  }
  const installer = resolve(import.meta.dirname, "../../../../install.sh");
  const env = (source: string) => ({
    PATH: process.env.PATH,
    HOME: scratch,
    AUNI_HOME: mkdtempSync(join(scratch, "home-")),
    AUNI_SOURCE: source,
  });

  it("is what its package.json says, read by install.sh without building anything", async () => {
    const source = sourceTarball("0.4.2");
    const home = env(source);
    expect(await sourceTag({ installer, env: home })).toBe("v0.4.2");
    expect(readdirSync(home.AUNI_HOME)).toEqual([]);
  });

  it("is never a pre-release, by the same rule as tags.ts", () => {
    // install.sh's own check, as the first install of a source runs it: a v0.2.0-rc.1 installed
    // would be a current version that `auni update` can't order against any release.
    const home = env(sourceTarball("0.2.0-rc.1"));
    const checked = spawnSync("sh", [installer], {
      env: { ...home, AUNI_CHECK: "1" },
      encoding: "utf8",
    });
    expect(checked.status).toBe(1);
    expect(checked.stderr.trim()).toBe("v0.2.0-rc.1 isn't a version such as v0.1.0.");
  });

  it("refuses a source that isn't one, in install.sh's words", async () => {
    await expect(
      sourceTag({ installer, env: env(join(scratch, "nowhere.tar.gz")) }),
    ).rejects.toThrow(
      new ReleaseRefused(
        `AUNI_SOURCE is neither a folder nor a tarball: ${join(scratch, "nowhere.tar.gz")}`,
      ),
    );
  });
});
