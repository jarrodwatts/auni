import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { selfCommand } from "./release/layout.ts";
import {
  enableLinger,
  installService,
  lingers,
  ownCommand,
  serviceCommand,
  serviceInstalled,
  startService,
  stopService,
  uninstallService,
} from "./service.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const machine = vi.hoisted(() => ({ platform: "linux" }));
// The command Auni runs as here, which a test may spell oddly.
const self = vi.hoisted(() => ({ command: null as string[] | null }));
vi.mock("./release/layout.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./release/layout.ts")>();
  return { ...real, selfCommand: () => self.command ?? real.selfCommand() };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => machine.platform,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(execFileSync).mockReset();
});

describe("auni service", () => {
  it("writes a systemd user unit for this machine, carrying where things are, and starts it", () => {
    const home = mkdtempSync(join(tmpdir(), "auni-service-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "/opt/100%/bin:/usr/bin");
    vi.stubEnv("AUNI_HOME", join(home, "auni data"));
    vi.stubEnv("CODEX_HOME", "");
    expect(serviceInstalled()).toBe(false);
    const said = installService();
    expect(said).toContain("Auni runs as a service now");
    // Lingering unknown here, so it says how to turn it on.
    expect(said).toContain("loginctl enable-linger");
    expect(serviceInstalled()).toBe(true);
    const unit = readFileSync(join(home, ".config/systemd/user/auni.service"), "utf8");
    // Auni as this shell runs it: from this checkout, here.
    const [node, auni] = selfCommand();
    expect(unit).toContain(`ExecStart="${node}" "${auni}" "--no-open"\n`);
    expect(unit).toContain(`WorkingDirectory=${home}/auni data\n`);
    expect(unit).toContain('Environment="PATH=/opt/100%%/bin:/usr/bin"');
    expect(unit).toContain(`Environment="AUNI_HOME=${home}/auni data"`);
    // So the running Auni says it is the service's, and `auni stop` stops it as one.
    expect(unit).toContain('Environment="AUNI_RUNS_AS=service"');
    expect(unit).not.toContain("CODEX_HOME=");
    expect(unit).not.toContain("@");
    expect(
      vi.mocked(execFileSync).mock.calls.map(([command, args]) => [command, ...args!]),
    ).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "auni"],
      ["loginctl", "show-user", userInfo().username, "--property=Linger", "--value"],
    ]);

    // With lingering on, it doesn't ask for it.
    vi.mocked(execFileSync).mockClear();
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => "" as never)
      .mockImplementationOnce(() => "" as never)
      .mockImplementationOnce((() => "yes\n") as never);
    expect(installService()).not.toContain("enable-linger");

    // As `auni update` and `auni stop` stop and start it.
    vi.mocked(execFileSync).mockClear();
    stopService();
    startService();
    expect(
      vi.mocked(execFileSync).mock.calls.map(([command, args]) => [command, ...args!]),
    ).toEqual([
      ["systemctl", "--user", "stop", "auni"],
      ["systemctl", "--user", "start", "auni"],
    ]);

    vi.mocked(execFileSync).mockClear();
    uninstallService();
    expect(
      vi.mocked(execFileSync).mock.calls.map(([command, args]) => [command, ...args!]),
    ).toEqual([["systemctl", "--user", "disable", "--now", "auni"]]);
    expect(() => readFileSync(join(home, ".config/systemd/user/auni.service"))).toThrow();
    expect(serviceInstalled()).toBe(false);
  });

  it.each(["linux", "darwin"])(
    "reads back the command it wrote on %s, however its paths are spelled",
    (platform) => {
      machine.platform = platform;
      vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "auni-service-")));
      self.command = ['/opt/100% "odd" \\ <node>', "/home/me/auni & co/apps/core/bin/auni.mjs"];
      try {
        expect(serviceCommand()).toBeNull();
        installService();
        // As doctor holds it to the command this folder would write, and to what is on disk.
        expect(serviceCommand()).toEqual([...self.command, "--no-open"]);
        expect(serviceCommand()).toEqual(ownCommand());
      } finally {
        self.command = null;
        machine.platform = "linux";
      }
    },
  );

  it("reads whether this user's services start at boot, and turns it on", () => {
    const said = (answer: string) =>
      vi.mocked(execFileSync).mockImplementationOnce((() => `${answer}\n`) as never);
    said("yes");
    expect(lingers()).toBe(true);
    said("no");
    expect(lingers()).toBe(false);
    // logind with nothing to say about this user: not a no.
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("Failed to get user");
    });
    expect(lingers()).toBeNull();

    enableLinger();
    expect(vi.mocked(execFileSync).mock.calls.at(-1)!.slice(0, 2)).toEqual([
      "loginctl",
      ["enable-linger", "--no-ask-password", expect.any(String)],
    ]);
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("Access denied");
    });
    expect(() => enableLinger()).toThrow(/run `sudo loginctl enable-linger \S+`$/u);
  });
});
