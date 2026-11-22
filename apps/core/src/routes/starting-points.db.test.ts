import express from "express";
import { beforeEach, describe, expect, it } from "vitest";

import { requireOwner } from "../auth/middleware.ts";
import { jobs, ownerSessions } from "../db/schema.ts";
import { env } from "../env.ts";
import { setOwner, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { serve } from "../test/serve.ts";
import { ownerRouter } from "./owner.ts";
import { startingPointsRouter } from "./starting-points.ts";

const url = serve(
  express().use("/owner", ownerRouter).use("/starting-points", requireOwner, startingPointsRouter),
);

const POINT = {
  statement: "You have $1,240.18.",
  action: "Look it over",
  prompt: "Look over my portfolio.",
  image: null,
  sources: [{ app: "auni", label: "Your money", link: "/app" }],
};

let cookie = "";
beforeEach(async () => {
  await wipe(ownerSessions, jobs);
  const { mintPairingCode } = await import("../auth/owner.ts");
  const paired = await fetch(url("/owner/pair"), {
    method: "POST",
    headers: { origin: env.WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ code: await mintPairingCode() }),
  });
  cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
});

const read = async () =>
  (await fetch(url("/starting-points"), { headers: { cookie } })).json() as Promise<unknown>;

describe("GET /starting-points", () => {
  it("answers only the owner's browser", async () => {
    expect((await fetch(url("/starting-points"))).status).toBe(401);
  });

  it("asks for them once while there are none", async () => {
    expect(await read()).toEqual({ points: [], pending: true });
    expect(await read()).toEqual({ points: [], pending: true });
    expect(await queued("starting-points")).toEqual([
      {
        kind: "starting-points",
        key: "starting-points:none",
        data: {},
        lanes: ["starting-points"],
      },
    ]);
  });

  // They quote numbers an hour changes, and a tap sends them as the owner's words.
  it("shows none past an hour old, and asks for new ones once", async () => {
    const writtenAt = new Date(Date.now() - 61 * 60_000);
    await setOwner({ startingPoints: [POINT], startingPointsAt: writtenAt });
    expect(await read()).toEqual({ points: [], pending: true });
    await read();
    expect(await queued("starting-points")).toMatchObject([
      { key: `starting-points:${writtenAt.toISOString()}` },
    ]);
  });

  it("shows those saved at once, and asks for nothing, while they're fresh", async () => {
    await setOwner({
      startingPoints: [POINT],
      startingPointsAt: new Date(Date.now() - 59 * 60_000),
    });
    expect(await read()).toEqual({ points: [POINT], pending: false });
    expect(await queued("starting-points")).toEqual([]);
  });
});
