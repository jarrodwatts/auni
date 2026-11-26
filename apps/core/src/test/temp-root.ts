import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    tempRoot: string;
  }
}

// A file can fail during collection, before Vitest runs its teardown hooks. The project
// still tears down after its workers finish, so it can remove any fixtures they left behind.
export default function setup({ provide }: TestProject): () => void {
  const base = tmpdir();
  // The Tailscale tests bind a Unix socket inside their home. Keep its path under
  // the 103-byte limit even when the caller's temporary directory is deeply nested.
  const shortBase = process.platform !== "win32" && Buffer.byteLength(base) > 64 ? "/tmp" : base;
  const root = mkdtempSync(join(shortBase, "a-"));
  const remove = () => rmSync(root, { recursive: true, force: true });
  process.once("exit", remove);
  provide("tempRoot", root);
  return () => {
    remove();
    process.off("exit", remove);
  };
}
