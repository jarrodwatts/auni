import { describe, expect, it } from "vitest";

import {
  bodyScale,
  edgeCue,
  flipsCap,
  headroom,
  placeY,
  poke,
  restPose,
  rubber,
  wantsAuni,
  type EdgeScene,
} from "./edge-pose";

const READY: EdgeScene = { kind: "ready" };
const running = (row: string | null): EdgeScene => ({ kind: "running", row });
const attention = (row: string | null, settled = false): EdgeScene => ({
  kind: "attention",
  row,
  settled,
});
const LANDED: EdgeScene = { kind: "landed" };
const FAILED: EdgeScene = { kind: "failed" };

describe("restPose", () => {
  it("peeks calmly at a card waiting on the person, and gets to work once it runs", () => {
    expect(restPose(READY)).toEqual({ place: "peek", mood: "calm", grip: true });
    expect(restPose(running("a"))).toEqual({ place: "peek", mood: "work", grip: true });
  });

  it("pulls itself up, worried, when a row needs the person", () => {
    expect(restPose(attention("a"))).toEqual({ place: "up", mood: "worried", grip: true });
  });

  it("sits on the edge, happy and letting go, once everything lands", () => {
    expect(restPose(LANDED)).toEqual({ place: "sit", mood: "happy", grip: false });
  });

  it("stays down and sad when it didn't go through for good", () => {
    expect(restPose(FAILED)).toEqual({ place: "eyes", mood: "sad", grip: true });
  });
});

describe("edgeCue", () => {
  it("only settles into its pose on arriving at a card", () => {
    expect(edgeCue(null, running("a"))).toBeNull();
    expect(edgeCue(null, attention("a"))).toBeNull();
  });

  it("cheers once the money the card waited on comes in", () => {
    const funding: EdgeScene = { kind: "funding" };
    expect(edgeCue(funding, READY)).toBe("funded");
    expect(edgeCue(READY, READY)).toBeNull();
    expect(edgeCue(funding, running("a"))).toBe("start");
  });

  it("hops when the person's tap starts the card", () => {
    expect(edgeCue(READY, running(null))).toBe("start");
    expect(edgeCue(READY, running("a"))).toBe("start");
  });

  it("nods to each new row, and holds still while the same one runs", () => {
    expect(edgeCue(running("a"), running("b"))).toBe("next");
    expect(edgeCue(running("a"), running("a"))).toBeNull();
    expect(edgeCue(running("a"), running(null))).toBeNull();
  });

  it("worries once when a row needs the person, and again for another row", () => {
    expect(edgeCue(running("a"), attention("a"))).toBe("worry");
    expect(edgeCue(attention("a"), attention("a"))).toBeNull();
    expect(edgeCue(attention("a"), attention("b"))).toBe("worry");
  });

  it("drops and peeks back up when a row that failed runs again", () => {
    expect(edgeCue(attention("a"), running("a"))).toBe("retried");
    expect(edgeCue(attention("a"), running("b"))).toBeNull();
  });

  it("celebrates the finish once, and slumps once when it fails for good", () => {
    expect(edgeCue(running("c"), LANDED)).toBe("finish");
    expect(edgeCue(LANDED, LANDED)).toBeNull();
    expect(edgeCue(attention("a"), FAILED)).toBe("slump");
    expect(edgeCue(FAILED, FAILED)).toBeNull();
  });

  it("goes quietly back to waiting", () => {
    expect(edgeCue(running("a"), READY)).toBeNull();
  });
});

describe("wantsAuni", () => {
  it("comes to a card first seen with money still to move", () => {
    expect(wantsAuni(READY, READY)).toBe("come");
    expect(wantsAuni(READY, running("a"))).toBe("come");
    expect(wantsAuni(running("a"), attention("a"))).toBe("come");
  });

  it("leaves be a card already settled when it first showed, even one that offers a retry", () => {
    expect(wantsAuni(LANDED, LANDED)).toBeNull();
    expect(wantsAuni(FAILED, FAILED)).toBeNull();
    expect(wantsAuni(attention(null, true), attention(null, true))).toBeNull();
    expect(wantsAuni(attention("a", true), attention("a", true))).toBeNull();
  });

  it("only keeps Auni once the card it watched settles, however it ended", () => {
    expect(wantsAuni(READY, LANDED)).toBe("keep");
    expect(wantsAuni(running("a"), FAILED)).toBe("keep");
    expect(wantsAuni(running("a"), attention("a", true))).toBe("keep");
  });

  it("wants nothing of a card with nothing to watch", () => {
    expect(wantsAuni(READY, null)).toBeNull();
  });
});

describe("placeY", () => {
  it("rises from out of sight, to its eyes, to peeking, to pulled up, to sitting on top", () => {
    const order = (["hidden", "eyes", "peek", "up", "sit"] as const).map((place) =>
      placeY(place, 60),
    );
    expect(order).toEqual(order.toSorted((left, right) => right - left));
  });

  it("is out of sight behind the card when hidden", () => {
    // The artwork's top is 36/256 of the way down its box.
    expect(placeY("hidden", 60) + (36 / 256) * 60).toBeGreaterThan(0);
  });

  it("keeps clear the room it takes sitting on top", () => {
    expect(headroom(60)).toBe(42);
  });
});

describe("bodyScale", () => {
  it("rests at its own shape", () => {
    expect(bodyScale(0, 0, 0)).toEqual({ x: 1, y: 1 });
  });

  it("stretches tall on the way up and squashes flat from a push, keeping its area", () => {
    const rising = bodyScale(-6, 0, 0);
    expect(rising.y).toBeGreaterThan(1);
    const pushed = bodyScale(0, 0.3, 0);
    expect(pushed.y).toBeLessThan(1);
    for (const { x, y } of [rising, pushed, bodyScale(4, -0.2, 0.01)]) {
      expect(x * y).toBeCloseTo(1);
    }
  });

  it("never stretches past what still reads as Auni", () => {
    expect(bodyScale(-100, -2, 0).y).toBeLessThanOrEqual(1.6);
    expect(bodyScale(100, 2, 0).y).toBeGreaterThanOrEqual(0.55);
  });
});

describe("rubber", () => {
  it("gives less the further it's pulled, and never past most of its height", () => {
    expect(rubber(0, 60)).toBe(0);
    expect(rubber(-20, 60)).toBe(0);
    const near = rubber(30, 60);
    const far = rubber(300, 60);
    expect(near).toBeGreaterThan(0);
    expect(far - near).toBeLessThan(300 - 30);
    expect(rubber(100_000, 60)).toBeLessThan(60 * 0.8);
  });
});

describe("poke", () => {
  it("counts quick pokes, and the fifth makes Auni dizzy and starts the count again", () => {
    let times: readonly number[] = [];
    for (const now of [0, 0.3, 0.6, 0.9]) {
      const next = poke(times, now);
      expect(next.dizzy).toBe(false);
      times = next.times;
    }
    expect(poke(times, 1.2)).toEqual({ times: [], dizzy: true });
  });

  it("forgets pokes from a while ago", () => {
    expect(poke([0, 0.2, 0.4, 0.6], 5)).toEqual({ times: [5], dizzy: false });
  });
});

describe("flipsCap", () => {
  it("flips about one finish in seven", () => {
    expect(flipsCap(0.1, false)).toBe(true);
    expect(flipsCap(0.2, false)).toBe(false);
  });

  it("never flips twice running", () => {
    expect(flipsCap(0, true)).toBe(false);
  });
});
