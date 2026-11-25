import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { inject, onTestFinished } from "vitest";

/** A scratch folder for one test. Pass afterAll during collection to share it across a suite. */
export function tempDir(
  prefix: string,
  register: (cleanup: () => void) => void = onTestFinished,
): string {
  const dir = mkdtempSync(join(inject("tempRoot"), prefix));
  register(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
