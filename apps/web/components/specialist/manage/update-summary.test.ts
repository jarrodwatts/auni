import { describe, expect, it } from "vitest";

import { describeSpecialistUpdate } from "./update-summary";

describe("describeSpecialistUpdate", () => {
  it("leads with the rename itself", () => {
    expect(
      describeSpecialistUpdate([
        { field: "name", before: "Peptides", after: "Nuclear" },
        { field: "purpose", before: "Old words", after: "Nuclear makes a comeback" },
      ]),
    ).toEqual({ lead: "Renamed to Nuclear", details: ["Now “Nuclear makes a comeback”"] });
  });

  it("leads with how it acts when that changed too", () => {
    expect(
      describeSpecialistUpdate([
        { field: "name", before: "Peptides", after: "GLP-1" },
        { field: "actMode", before: "ask_first", after: "within_limits" },
      ]),
    ).toEqual({ lead: "Now acts on its own", details: ["Renamed to GLP-1"] });
  });

  it("reads new words alone as reworded", () => {
    expect(
      describeSpecialistUpdate([{ field: "purpose", before: "Old", after: "Nuclear is back" }]),
    ).toEqual({ lead: "Reworded", details: ["Now “Nuclear is back”"] });
  });
});
