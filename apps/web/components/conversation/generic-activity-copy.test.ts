import { describe, expect, it } from "vitest";

import { toolStepStatus } from "./generic-activity-copy";

describe("toolStepStatus", () => {
  it("marks a step done once its output is in, and failed when it was turned down", () => {
    expect(toolStepStatus("output-available", true)).toBe("done");
    expect(toolStepStatus("output-available", false)).toBe("done");
    expect(toolStepStatus("output-denied", true)).toBe("failed");
  });

  it("marks a step under way only while its turn still runs", () => {
    expect(toolStepStatus("input-streaming", true)).toBe("now");
    expect(toolStepStatus("input-available", true)).toBe("now");
    // Stopped before it finished: no mark, rather than one that turns forever.
    expect(toolStepStatus("input-available", false)).toBeNull();
  });
});
