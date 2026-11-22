import { describe, expect, it } from "vitest";

import { jobs } from "./index.ts";
import * as kinds from "./kinds.ts";

// The runner claims only the kinds it runs, so a kind queued with no job would wait forever.
describe("job kinds", () => {
  it("has a job for every kind something queues", () => {
    const queued = Object.values(kinds).flatMap((kind) =>
      typeof kind === "object" && "enqueue" in kind ? [kind.name] : [],
    );
    expect(queued.length).toBeGreaterThan(0);
    const run = new Set(jobs.map((job) => job.kind.name));
    expect(queued.filter((name) => !run.has(name))).toEqual([]);
  });
});
