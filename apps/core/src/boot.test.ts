import { afterEach, describe, expect, it } from "vitest";

import { boot } from "./boot.ts";

describe("boot", () => {
  afterEach(() => {
    Object.assign(process.report, { excludeNetwork: false });
  });

  // A report with the network looks up each open socket's peer, freezing Auni for seconds.
  it("keeps the network out of Node's diagnostic report, which the brain's SDK takes", async () => {
    Object.assign(process.report, { excludeNetwork: false });
    expect(await boot()).toBeNull(); // DATABASE_URL is set, so no Postgres is started
    expect(process.report).toHaveProperty("excludeNetwork", true);
  });
});
