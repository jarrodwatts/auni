import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** The repo root, where Codex starts joining AGENTS.md files. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Codex reads 32 KiB of AGENTS.md, joined from the repo root down to the folder it starts in, and
 * cuts the rest with only a warning. Every chain stays well under that, so `codex review` reads the
 * whole root, the Code Review Rules at its end included.
 */
const BUDGET = 24 * 1024;

/**
 * The repo's files, repo-relative. Listed by git rather than by walking the disk, since
 * scaffold.test.ts writes apps beside the real ones while this runs; one that is gone by the
 * time it is read is left out.
 */
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((path) => path && existsSync(join(ROOT, path)));

/** Every AGENTS.md in the repo, with its text. */
const docs = new Map(
  files
    .filter((path) => posix.basename(path) === "AGENTS.md")
    .map((path) => [path, readFileSync(join(ROOT, path), "utf8")] as const),
);

/** The name of every file in the repo, for a doc that names one bare (`asks.ts`). */
const names = new Set(files.map((path) => posix.basename(path)));

/** The AGENTS.md files Codex joins when it starts in `doc`'s folder: the root's first. */
function chain(doc: string): string[] {
  const folders: string[] = [];
  for (let dir = posix.dirname(doc); dir !== "."; dir = posix.dirname(dir)) folders.unshift(dir);
  return ["AGENTS.md", ...folders.map((dir) => `${dir}/AGENTS.md`)].filter((path) =>
    docs.has(path),
  );
}

const bytes = (path: string) => Buffer.byteLength(docs.get(path)!);

/**
 * The files and folders a doc names: each backticked token ending in a source file's extension or
 * a `/`, leaving out absolute and relative paths, URLs, packages, home paths, globs and
 * placeholders. Code such as `meta.tools`, and `.env` files, end in no such extension.
 */
function pathsIn(text: string): string[] {
  return [...text.matchAll(/`([^`\s]+)`/gu)]
    .map(([, token]) => token!.split(":")[0]!)
    .filter(
      (token) =>
        /\.(?:[cm]?[jt]sx?|json|md|sql|txt|ya?ml|sh|css)$|\/$/u.test(token) &&
        !/^(?:\/|\.\.\/|http|@|~|\$)/u.test(token) &&
        !/[<*]/u.test(token),
    );
}

/**
 * Whether `token` names a file or folder. A bare name is any file's in the repo; a path resolves
 * from the doc's folder, any folder above, or core's src.
 */
function resolves(doc: string, token: string): boolean {
  if (!token.includes("/")) return names.has(token);
  const bases = [join(ROOT, "apps/core/src")];
  for (let dir = dirname(doc); ; dir = dirname(dir)) {
    bases.push(join(ROOT, dir));
    if (dir === ".") break;
  }
  return bases.some((base) => existsSync(join(base, token)));
}

describe("AGENTS.md", () => {
  it("keeps every folder's chain within Codex's budget", () => {
    const over = [...docs.keys()]
      .map(chain)
      .map((paths) => ({ paths, total: paths.reduce((sum, path) => sum + bytes(path), 0) }))
      .filter(({ total }) => total > BUDGET)
      .map(({ paths, total }) => `${paths.join(" + ")}: ${total} bytes`);
    expect(over, `over ${BUDGET} bytes`).toEqual([]);
  });

  it("ends the root with the Code Review Rules", () => {
    const headings = docs.get("AGENTS.md")!.match(/^## .*$/gmu) ?? [];
    expect(headings.at(-1)).toBe("## Code Review Rules");
  });

  it("names, in the root, every AGENTS.md but an app's own", () => {
    const root = docs.get("AGENTS.md")!;
    const unnamed = [...docs.keys()].filter(
      (doc) =>
        doc !== "AGENTS.md" &&
        !/^apps\/core\/src\/apps\/[^/]+\/AGENTS\.md$/u.test(doc) &&
        !root.includes(`\`${doc}\``),
    );
    expect(unnamed).toEqual([]);
  });

  it("names only paths that exist", () => {
    const missing = [...docs].flatMap(([doc, text]) =>
      pathsIn(text)
        .filter((token) => !resolves(doc, token))
        .map((token) => `${doc}: ${token}`),
    );
    expect(missing).toEqual([]);
  });
});
