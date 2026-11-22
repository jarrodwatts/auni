import express from "express";
import { describe, expect, it } from "vitest";

import { serve } from "../test/serve.ts";
import { meRouter } from "./me.ts";

const url = serve(express().use("/me", meRouter));

const patch = (body: unknown) =>
  fetch(url("/me"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /me", () => {
  it("refuses a time zone no browser names, before saving anything", async () => {
    for (const zone of ["Not/AZone", "", "UTC; drop table owner"]) {
      const response = await patch({ time_zone: zone });
      expect(response.status).toBe(400);
    }
  });

  // Intl takes "+10:00", but Postgres reads a bare offset with its sign flipped: ten hours west.
  it("refuses a bare offset, which would put their midnight on the wrong side of the world", async () => {
    expect((await patch({ time_zone: "+10:00" })).status).toBe(400);
  });
});
