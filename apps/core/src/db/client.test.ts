import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let failQuery: ((error: Error) => void) | undefined;
let endMock: ReturnType<typeof vi.fn<() => Promise<void>>>;

vi.mock("../env.ts", () => ({
  env: { DATABASE_URL: "postgres://test/auni" },
}));

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    const sql = Object.assign(
      () =>
        new Promise<never>((_resolve, reject) => {
          failQuery = reject;
        }),
      {
        end: () => endMock(),
        listen: vi.fn(),
        options: { parsers: {}, serializers: {} },
      },
    );
    return sql;
  }),
}));

describe("databaseFiles()", () => {
  let warnings: string[];

  beforeEach(() => {
    vi.resetModules();
    failQuery = undefined;
    endMock = vi.fn(async () => {});
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
      warnings.push(parts.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when Postgres refuses data_directory while running", async () => {
    const { databaseFiles } = await import("./client.ts");
    const asked = databaseFiles();
    failQuery!(new Error("permission denied"));
    expect(await asked).toBeNull();
    expect(warnings.join("\n")).toContain("Postgres won't say where it keeps its files");
  });

  it("stays quiet when the query fails because Auni is closing its database connection", async () => {
    const { closeDatabaseConnection, databaseFiles } = await import("./client.ts");
    const asked = databaseFiles();
    const closing = closeDatabaseConnection();
    failQuery!(new Error("write CONNECTION_ENDED 127.0.0.1:5432"));
    await closing;
    expect(await asked).toBeNull();
    expect(warnings).toEqual([]);
  });
});
