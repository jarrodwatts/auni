import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serve } from "../test/serve.ts";
import { failed } from "./failed.ts";

// Core's last handler, behind a router as every one of core's is mounted: a JSON body limited
// to 4kb, a route that answers, and one that throws.
const router = express.Router();
router.use(express.json({ limit: "4kb" }));
router.post("/answers", (_req, res) => void res.json({ ok: true }));
router.post("/throws", () => {
  throw new Error("a handler broke");
});
const url = serve(express().use(router).use(failed));

const post = async (path: string, body: string) => {
  const answer = await fetch(url(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: answer.status, body: await answer.json() };
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("core's last handler", () => {
  it("answers 400 to a body that is not JSON, and logs none of it", async () => {
    expect(await post("/answers", '{"key": "sk-typed-by-the-owner"')).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is too long, and logs none of it", async () => {
    const long = JSON.stringify({ key: "k".repeat(5_000) });
    expect(await post("/answers", long)).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(logged).not.toHaveBeenCalled();
  });

  it("logs what a handler threw, and answers 500 without it", async () => {
    expect(await post("/throws", "{}")).toEqual({ status: 500, body: { error: "internal" } });
    expect(logged).toHaveBeenCalledWith("POST /throws failed:", expect.any(Error));
  });

  it("leaves a good body to its route", async () => {
    expect(await post("/answers", "{}")).toEqual({ status: 200, body: { ok: true } });
  });
});
