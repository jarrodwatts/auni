import { describe, expect, it } from "vitest";

import { specialistRow } from "../test/rows.ts";
import {
  changeLines,
  fieldChanges,
  restoredFields,
  stillAsEdited,
  undoWidens,
  widensWhatRuns,
} from "./rules.ts";

const row = specialistRow();

describe("what only the owner's tap can allow", () => {
  const acting = specialistRow({ actMode: "within_limits" });

  it("is letting it act on its own, or more money while it does", () => {
    expect(widensWhatRuns(row, { actMode: "within_limits" })).toBe(true);
    expect(widensWhatRuns(row, { actMode: "within_limits", potUsd: "100" })).toBe(true);
    expect(widensWhatRuns(acting, { potUsd: "200.01" })).toBe(true);
  });

  it("leaves out what runs no more without a tap", () => {
    expect(widensWhatRuns(row, { potUsd: "10000000" })).toBe(false);
    expect(widensWhatRuns(acting, { potUsd: "150", name: "Atoms" })).toBe(false);
    expect(widensWhatRuns(acting, { actMode: "within_limits", potUsd: "200" })).toBe(false);
    // Asking first again, it may hold as much as they like.
    expect(widensWhatRuns(acting, { actMode: "ask_first", potUsd: "900" })).toBe(false);
  });
});

describe("chat edits", () => {
  it("records only what really changed", () => {
    // "Let it act on its own", with a pot restated at the same amount.
    const changes = fieldChanges(row, { actMode: "within_limits", potUsd: "200" });
    expect(changes).toEqual({
      before: { actMode: "ask_first" },
      after: { actMode: "within_limits" },
    });
  });

  it("records nothing for a patch that changes nothing", () => {
    expect(fieldChanges(row, { name: "Nuclear", actMode: "ask_first" }).after).toEqual({});
  });

  it("names each change the way the receipt shows it", () => {
    const update = fieldChanges(row, { actMode: "within_limits", name: "Atoms" });
    expect(changeLines(update)).toEqual([
      { field: "name", before: "Nuclear", after: "Atoms" },
      { field: "actMode", before: "ask_first", after: "within_limits" },
    ]);
  });
});

describe("undo", () => {
  const update = fieldChanges(row, { potUsd: "300", actMode: "within_limits" });
  const edited = { ...row, potUsd: "300.00", actMode: "within_limits" as const };

  it("puts back exactly the fields the edit changed", () => {
    expect(restoredFields(update)).toEqual({ potUsd: "200.00", actMode: "ask_first" });
  });

  it("is allowed while the edit's values still stand", () => {
    expect(stillAsEdited(edited, update.after)).toBe(true);
    // A later change to another field doesn't stand in the way.
    expect(stillAsEdited({ ...edited, name: "Atoms" }, update.after)).toBe(true);
  });

  it("is refused once a later change touched the same field", () => {
    expect(stillAsEdited({ ...edited, actMode: "ask_first" }, update.after)).toBe(false);
  });

  it("compares dollar fields by amount, not spelling", () => {
    const pot = fieldChanges(row, { potUsd: "300" });
    expect(stillAsEdited({ ...row, potUsd: "300.00" }, pot.after)).toBe(true);
    expect(restoredFields(pot)).toEqual({ potUsd: "200.00" });
  });
});

describe("undo never widens what runs", () => {
  // Acting on its own with $200, switched to ask first; the record keeps how it stood.
  const asked = specialistRow();
  const update = {
    before: { actMode: "within_limits" as const, potUsd: "200.00" },
    after: { actMode: "ask_first" as const },
  };

  it("lets it act on its own again with the pot it had then, or less", () => {
    expect(undoWidens(asked, update)).toBe(false);
    expect(undoWidens({ ...asked, potUsd: "150.00" }, update)).toBe(false);
  });

  it("is refused once the pot has grown since", () => {
    expect(undoWidens({ ...asked, potUsd: "1000000.00" }, update)).toBe(true);
  });

  it("puts a pot back only as far as it acted on its own with then", () => {
    const acting = specialistRow({ actMode: "within_limits", potUsd: "100.00" });
    const lowered = {
      before: { actMode: "within_limits" as const, potUsd: "900.00" },
      after: { potUsd: "100" },
    };
    expect(undoWidens(acting, lowered)).toBe(false);
    // Lowered while it asked first, and allowed to act on its own since.
    const whileAsking = { ...lowered, before: { actMode: "ask_first" as const, potUsd: "900.00" } };
    expect(undoWidens(acting, whileAsking)).toBe(true);
  });

  it("leaves alone an undo that widens nothing", () => {
    const acting = specialistRow({ actMode: "within_limits", potUsd: "1000000.00" });
    const renamed = { before: { name: "Atoms" }, after: { name: "Nuclear" } };
    expect(undoWidens(acting, renamed)).toBe(false);
  });

  it("refuses a widening undo whose record doesn't say how it stood", () => {
    expect(
      undoWidens(asked, { before: { actMode: "within_limits" }, after: { actMode: "ask_first" } }),
    ).toBe(true);
  });
});
