import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildVersion } from "./web-app.ts";

// The web app is built again only when what it is built from changes; an app's own card is
// part of that, though it lives in core's folders.

const repo = mkdtempSync(join(tmpdir(), "auni-build-version-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
const write = (file: string, text: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};
const commit = () => {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
};

git("init", "-q");
write("apps/web/page.tsx", "page");
write("packages/shared/index.ts", "shared");
write("apps/core/src/apps/elfa/tape.card.tsx", "card");
write("apps/core/src/apps/elfa/tape.schema.ts", "schema");
write("apps/core/src/apps/elfa/request.ts", "server");
commit();

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("buildVersion", () => {
  it("changes when an app's card or its schema does, and not for its other code", () => {
    const first = buildVersion({}, repo);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    write("apps/core/src/apps/elfa/request.ts", "server, changed");
    expect(buildVersion({}, repo)).toBe(first);
    commit();
    expect(buildVersion({}, repo)).toBe(first);
    write("apps/core/src/apps/elfa/tape.card.tsx", "card, changed");
    // Not yet committed, so it builds every time.
    expect(buildVersion({}, repo)).toBeNull();
    commit();
    const second = buildVersion({}, repo);
    expect(second).not.toBe(first);
    write("apps/core/src/apps/elfa/tape.schema.ts", "schema, changed");
    commit();
    expect(buildVersion({}, repo)).not.toBe(second);
  });
});
