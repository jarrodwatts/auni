import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serveDoorAgain } from "./always-on.ts";
import { holdAgain, letGo } from "./boot.ts";
import { doctor, type Finding } from "./doctor.ts";
import { doctorCommand, whileStopped } from "./repairs.ts";
import { cameUp, runningAuni, stopAuni, type RunningAuni } from "./running.ts";
import { enableLinger, installService, startService } from "./service.ts";

vi.mock("./doctor.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor.ts")>()),
  doctor: vi.fn(),
}));
vi.mock("./running.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./running.ts")>()),
  runningAuni: vi.fn(),
  stopAuni: vi.fn(),
  cameUp: vi.fn(),
}));
vi.mock("./boot.ts", () => ({ letGo: vi.fn(), holdAgain: vi.fn() }));
vi.mock("./always-on.ts", () => ({ serveDoorAgain: vi.fn() }));
vi.mock("./service.ts", () => ({
  enableLinger: vi.fn(),
  installService: vi.fn(() => "Auni runs as a service now."),
  serviceOutput: () => "journalctl --user -u auni -n 100 --no-pager",
  startService: vi.fn(),
}));

const SERVICE: RunningAuni = { as: "service", pid: 4242, here: true };
const machine = { up: false };

/** A service installed but stopped, with linger off: two recommended repairs, and one not. */
const BROKEN: Finding[] = [
  {
    check: "runner",
    status: "fix",
    says: "Auni isn't running, though its service is installed",
    repair: { id: "start-service", recommended: true },
  },
  {
    check: "service",
    status: "fix",
    says: "Auni stops when you log out, and starts again only when you log in",
    repair: { id: "linger", recommended: true },
  },
  { check: "wallet", status: "ok", says: "local key" },
];
const FIXED: Finding[] = [{ check: "runner", status: "ok", says: "running as a service" }];

/** Everything `auni doctor` said, on stdout and on stderr. */
let said: { out: string[]; err: string[] };
beforeEach(() => {
  said = { out: [], err: [] };
  vi.spyOn(console, "log").mockImplementation((text: string) => void said.out.push(text));
  vi.spyOn(console, "error").mockImplementation((text: string) => void said.err.push(text));
  vi.mocked(doctor).mockResolvedValueOnce(BROKEN).mockResolvedValueOnce(FIXED);
  // Auni runs once the service is started, and comes up at once.
  machine.up = false;
  vi.mocked(runningAuni).mockImplementation(async () => (machine.up ? SERVICE : null));
  vi.mocked(cameUp).mockImplementation(async () => machine.up);
  vi.mocked(startService).mockImplementation(() => void (machine.up = true));
  vi.mocked(stopAuni).mockResolvedValue(true);
});
afterEach(() => vi.resetAllMocks());

const run = { json: false, fix: false, dryRun: false, ask: null } as const;

describe("auni doctor's repairs", () => {
  it("--fix runs the recommended ones in their order, then says how things stand", async () => {
    expect(await doctorCommand({ ...run, fix: true, verbose: true })).toBe(0);
    // Linger before the start: the order repairs.ts lists them in, not the findings'.
    expect(vi.mocked(enableLinger).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(startService).mock.invocationCallOrder[0]!,
    );
    expect(said.out.join("\n")).toContain(
      [
        "Repairs:",
        "  Start Auni's service at boot, and keep it running when you log out (recommended)",
        "  Start Auni's service (recommended)",
      ].join("\n"),
    );
    expect(said.out.join("\n")).toContain("After repairs:\nok   runner: running as a service");
  });

  // So the service starts Postgres as its own, in its own cgroup, rather than use doctor's.
  it("lets go of the database while it starts the service, and holds it again once it's up", async () => {
    await doctorCommand({ ...run, fix: true });
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0]!;
    expect(order(letGo)).toBeLessThan(order(startService));
    expect(order(startService)).toBeLessThan(order(cameUp));
    expect(order(cameUp)).toBeLessThan(order(holdAgain));
  });

  it("holds the database again when the service doesn't come up, and says where to look", async () => {
    vi.mocked(cameUp).mockResolvedValue(false);
    expect(await doctorCommand({ ...run, fix: true })).toBe(0);
    expect(said.out).toContain(
      "  Failed: Auni didn't start within 90 seconds. Check logs with: journalctl --user -u auni -n 100 --no-pager.",
    );
    expect(holdAgain).toHaveBeenCalledOnce();
  });

  it("asks about each in a terminal, and runs only those said yes to", async () => {
    const ask = vi.fn(async ({ id }: { id: string }) => id === "start-service");
    expect(await doctorCommand({ ...run, ask })).toBe(0);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(startService).toHaveBeenCalledOnce();
    expect(enableLinger).not.toHaveBeenCalled();
  });

  it("runs none on a dry run, or with no terminal to ask in and no --fix", async () => {
    vi.mocked(doctor).mockReset().mockResolvedValue(BROKEN);
    expect(await doctorCommand({ ...run, dryRun: true, fix: true })).toBe(1);
    expect(said.out.at(-1)).toBe("Dry run: nothing changed.");
    expect(await doctorCommand(run)).toBe(1);
    expect(said.out.at(-1)).toMatch(/^Auni is stopped\.\nRun: pnpm auni doctor --fix/u);
    expect(startService).not.toHaveBeenCalled();
    expect(enableLinger).not.toHaveBeenCalled();
  });

  it("says one that fails, and still runs the next", async () => {
    vi.mocked(enableLinger).mockImplementation(() => {
      throw new Error("this machine wants an administrator for that");
    });
    await doctorCommand({ ...run, fix: true });
    expect(said.out).toContain("  Failed: this machine wants an administrator for that.");
    expect(startService).toHaveBeenCalledOnce();
  });

  it("with --json, prints the findings alone on stdout, each repair with what it does", async () => {
    expect(await doctorCommand({ ...run, json: true, fix: true })).toBe(0);
    expect(said.out).toEqual([JSON.stringify(FIXED, null, 2)]);
    expect(said.err.join("\n")).toContain("Start Auni's service.\n  Done.");

    vi.mocked(doctor).mockResolvedValueOnce(BROKEN);
    await doctorCommand({ ...run, json: true });
    expect(JSON.parse(said.out.at(-1)!)[0].repair).toEqual({
      id: "start-service",
      recommended: true,
      does: "Start Auni's service",
    });
  });

  // Always on: what `auni up --always-on` set, put back. It changes no setting, so Auni runs on.
  it("puts `tailscale serve` back without stopping Auni", async () => {
    vi.mocked(doctor)
      .mockReset()
      .mockResolvedValueOnce([
        {
          check: "always-on",
          status: "fix",
          says: "Tailscale doesn't send https://box.tailnet-example.ts.net to Auni's door",
          repair: { id: "tailscale-serve", recommended: true },
        },
      ])
      .mockResolvedValueOnce(FIXED);
    expect(await doctorCommand({ ...run, fix: true })).toBe(0);
    expect(serveDoorAgain).toHaveBeenCalledOnce();
    expect(stopAuni).not.toHaveBeenCalled();
  });

  it("reports missing always-on service setup separately from running background work", async () => {
    vi.mocked(doctor)
      .mockReset()
      .mockResolvedValue([
        { check: "runner", status: "ok", says: "running in a terminal" },
        { check: "web", status: "ok", says: "answers" },
        {
          check: "always-on",
          status: "fix",
          says: "Auni stops on logout",
          repair: { id: "install-service", recommended: true },
        },
      ]);

    expect(await doctorCommand(run)).toBe(1);
    expect(said.out[0]).toMatch(/^Auni is running, with checks to review\./u);
    expect(said.out[0]).toContain("Needs attention: Remote access");
    expect(said.out[0]).toContain("Passed: Background work, Web app");
  });

  it("leaves the choice to install a service behind verbose help on a stopped local Auni", async () => {
    vi.mocked(doctor)
      .mockReset()
      .mockResolvedValue([
        {
          check: "runner",
          status: "fix",
          says: "Auni isn't running",
          repair: { id: "install-service", recommended: false },
        },
      ]);
    const ask = vi.fn(async () => false);

    expect(await doctorCommand({ ...run, ask })).toBe(1);
    expect(said.out[0]).toMatch(/^Auni is stopped\.\nRun: pnpm auni\n/u);
    expect(ask).not.toHaveBeenCalled();
    await doctorCommand({ ...run, verbose: true });
    expect(said.out.at(-1)).toBe(
      "To choose an optional repair, run pnpm auni doctor --verbose in a terminal.",
    );
    await doctorCommand({ ...run, ask, verbose: true });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: "install-service" }));
  });

  it("never runs one that isn't recommended unasked", async () => {
    vi.mocked(doctor)
      .mockReset()
      .mockResolvedValue([
        {
          check: "runner",
          status: "fix",
          says: "Auni isn't running",
          repair: { id: "install-service", recommended: false },
        },
      ]);
    await doctorCommand({ ...run, fix: true });
    expect(installService).not.toHaveBeenCalled();
    expect(said.out.at(-1)).toBe("No recommended repairs to run. Nothing changed.");
  });
});

describe("a repair that needs Auni stopped", () => {
  const say = vi.fn();
  beforeEach(() => void (machine.up = true));

  it("stops the service, and starts it again even when the repair fails", async () => {
    const repair = vi.fn(async () => {
      expect(stopAuni).toHaveBeenCalledWith(SERVICE);
      expect(startService).not.toHaveBeenCalled();
      throw new Error("tailscale isn't running");
    });
    await expect(whileStopped(repair, say)).rejects.toThrow("tailscale isn't running");
    expect(startService).toHaveBeenCalledOnce();
  });

  it("changes nothing when the service won't stop, and never stops one run another way", async () => {
    vi.mocked(stopAuni).mockResolvedValue(false);
    const repair = vi.fn(async () => {});
    await expect(whileStopped(repair, say)).rejects.toThrow(/didn't stop within 2\.5 minutes/u);
    expect(repair).not.toHaveBeenCalled();
    expect(startService).not.toHaveBeenCalled();

    vi.mocked(runningAuni).mockResolvedValue({ as: "terminal", pid: 7, here: true });
    await whileStopped(repair, say);
    expect(repair).toHaveBeenCalledOnce();
    expect(stopAuni).toHaveBeenCalledOnce();
    expect(say).toHaveBeenLastCalledWith(
      "  Auni is running in a terminal. Restart it there to apply this change.",
    );
  });
});
