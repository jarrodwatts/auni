import { describe, expect, it } from "vitest";

import { deciding, settlement, type Receipt } from "./reconcile.ts";

const move = (receipt: Receipt) => ({ receipt, setup: false });
const setup = (receipt: Receipt) => ({ receipt, setup: true });

describe("settlement", () => {
  it("waits while nothing was sent or anything is still pending", () => {
    expect(settlement([], false)).toBe("pending");
    expect(settlement([setup("confirmed"), move("pending")], false)).toBe("pending");
  });

  it("fails a run that stopped after setting up, before the move", () => {
    expect(settlement([setup("confirmed")], false)).toBe("set-up-only");
  });

  it("fails a run whose last move reverted", () => {
    expect(settlement([setup("confirmed"), move("reverted")], false)).toBe("reverted");
  });

  it("counts a retried move that landed", () => {
    expect(settlement([move("reverted"), move("confirmed")], false)).toBe("done");
  });

  // A move sent in steps can revert in a later one after earlier ones landed.
  it("never says nothing moved once a move landed, though a later one reverted", () => {
    expect(settlement([move("confirmed"), move("reverted")], false)).toBe("partway");
    expect(settlement([move("confirmed"), move("reverted")], true)).toBe("unrecorded");
  });

  it("finishes a confirmed move with no fills to record, but never a trade", () => {
    expect(settlement([setup("confirmed"), move("confirmed")], false)).toBe("done");
    expect(settlement([move("confirmed")], true)).toBe("unrecorded");
  });
});

describe("deciding", () => {
  // A post kept as maybe sent before it went (see posting in actions.ts) has nothing to read.
  it("lets what the venue named for a post speak for the mark kept before it went", () => {
    const mark = { chain: "polygon" };
    const took = { chain: "polygon", relayerId: "r1" };
    const landed = { chain: "polygon", relayerId: "r1", hash: "0xa" };
    expect(deciding([mark])).toEqual([mark]);
    expect(deciding([mark, took])).toEqual([took]);
    expect(deciding([mark, took, landed])).toEqual([landed]);
    // A step before the move never answers for the move's own post.
    expect(deciding([mark, { ...took, setup: true as const }])).toHaveLength(2);
    // Nothing kept before a mark answers for it.
    expect(deciding([took, mark])).toEqual([took, mark]);
  });

  it("lets a send's hashed copy speak for the one kept by its wallet's id", () => {
    const accepted = { chain: "base", walletTxId: "p1" };
    const landed = { chain: "base", walletTxId: "p1", hash: "0xa" };
    expect(deciding([accepted, landed])).toEqual([landed]);
    expect(deciding([accepted])).toEqual([accepted]);
  });

  // A stuck send replaced at a higher fee comes back from its wallet under the replacement's hash.
  it("lets the hash a send was replaced by speak for the one it was sent as", () => {
    const sent = { chain: "monad", walletTxId: "j1", hash: "0xa" };
    const replaced = { chain: "monad", walletTxId: "j1", hash: "0xb" };
    const other = { chain: "monad", walletTxId: "j2", hash: "0xc" };
    expect(deciding([sent, other, replaced])).toEqual([other, replaced]);
    expect(deciding([sent])).toEqual([sent]);
  });

  it("lets a relayed send's hashed copy speak for the one kept by its relayer id", () => {
    const taken = { chain: "polygon", relayerId: "r1", setup: true as const };
    const landed = { ...taken, hash: "0xa" };
    expect(deciding([taken, landed])).toEqual([landed]);
    expect(deciding([taken])).toEqual([taken]);
  });

  it("keeps an order the venue took with nothing to read, so its setup alone can't fail it", () => {
    const approvals = { chain: "polygon", hash: "0xa", setup: true as const };
    const order = { chain: "polygon" };
    expect(deciding([approvals, order])).toEqual([approvals, order]);
  });

  it("lets an order's trade hashes speak for it once Polymarket names them", () => {
    const approvals = { chain: "polygon", hash: "0xa", setup: true as const };
    const order = { chain: "polygon" };
    const trade = { chain: "polygon", hash: "0xb" };
    expect(deciding([approvals, order, trade])).toEqual([approvals, trade]);
  });

  // A move sent in steps: step 1 landed, and step 2 got no answer.
  it("holds a send that got no answer for a person, whatever landed before it", () => {
    const landed = { chain: "ethereum", walletTxId: "p1", hash: "0xa" };
    const unanswered = { chain: "ethereum" };
    const sent = deciding([landed, unanswered]);
    expect(sent).toEqual([landed, unanswered]);
    // Its receipt reads as pending, so the action is never settled as done or partway.
    expect(settlement([move("confirmed"), move("pending")], false)).toBe("pending");
  });
});
