import { describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ fails: null as string | null }));
vi.mock("node:fs", async (actual) => ({
  ...(await actual<typeof import("node:fs")>()),
  writeSync: (_fd: number, text: string) => {
    if (fs.fails) throw Object.assign(new Error(fs.fails), { code: fs.fails });
    return text.length;
  },
}));

const { toTerminal } = await import("./terminal.ts");

describe("toTerminal", () => {
  it("says how much it wrote", () => {
    fs.fails = null;
    expect(toTerminal("hello")).toBe(5);
  });

  // Live: closing the window while the scene played threw EIO, and Auni died with Postgres running.
  it("answers false once the terminal is gone, its window closed or its reader gone", () => {
    for (const code of ["EIO", "EPIPE"]) {
      fs.fails = code;
      expect(toTerminal("\u001B[?25h")).toBe(false);
    }
  });

  it("throws any other failure, such as a terminal that can't take more just now", () => {
    fs.fails = "EAGAIN";
    expect(() => toTerminal("hello")).toThrow("EAGAIN");
  });
});
