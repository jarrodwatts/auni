import { mkdtempSync, rmSync } from "node:fs";
import { sep } from "node:path";

import { inject, onTestFinished } from "vitest";

/** A scratch folder for one test. Pass afterAll during collection to share it across a suite. */
export function tempDir(
  prefix: string,
  register: (cleanup: () => void) => void = onTestFinished,
): string {
  // Not join(): with an empty prefix it drops the separator, and the folder lands beside the
  // run's root, outside its teardown.
  const dir = mkdtempSync(`${inject("tempRoot")}${sep}${prefix}`);
  register(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
