import { describe, expect, it, vi } from "vitest";

import { doorRoute, portFor, tailnetOrigin, up, upSaid, type UpHost } from "./always-on.ts";

const OWNER = "owner@example.com";
const NAME = "box.tailnet-example.ts.net";

/** A machine on the owner's tailnet where every step works, which each test changes a little. */
function machine(changes: Partial<UpHost> = {}) {
  const host = {
    onTailnet: vi.fn(async () => ({ login: OWNER, name: NAME })),
    served: vi.fn(async (): Promise<ReadonlyMap<number, string>> => new Map()),
    save: vi.fn(),
    restartAsService: vi.fn(async () => undefined),
    enableLinger: vi.fn(async () => true),
    serve: vi.fn(async () => "done" as const),
    reaches: vi.fn(async () => true),
    staysOn: vi.fn(async () => ({
      stays: true,
      laptop: false,
      says: "Auni starts when this machine does, and keeps running.",
    })),
    linux: true,
    ...changes,
  } satisfies UpHost;
  return host;
}

describe("auni up --always-on", () => {
  it("records the owner and the address, runs the service, and has Tailscale serve the door", async () => {
    const host = machine();
    const report = await up(443, host);
    expect(report).toMatchObject({ ok: true, address: `https://${NAME}`, owner: OWNER });
    expect(report.steps.map(({ step, status }) => [step, status])).toEqual([
      ["tailscale", "done"],
      ["port", "done"],
      ["settings", "done"],
      ["service", "done"],
      ["linger", "done"],
      ["serve", "done"],
      ["reaches", "done"],
    ]);
    expect(host.save).toHaveBeenCalledWith(OWNER, `https://${NAME}`);
    expect(host.serve).toHaveBeenCalledWith([
      "tailscale",
      "serve",
      "--bg",
      "--https=443",
      doorRoute(),
    ]);
    // The door is a unix socket, never a port on this machine.
    expect(doorRoute()).toMatch(/^unix:\/.*\/serve\/auni\.sock$/u);
    expect(host.reaches).toHaveBeenCalledWith(`https://${NAME}`);
  });

  it("names the port in the address unless it's https's own", () => {
    expect(tailnetOrigin(NAME, 443)).toBe(`https://${NAME}`);
    expect(tailnetOrigin(NAME, 8443)).toBe(`https://${NAME}:8443`);
  });

  it("changes nothing on a machine that isn't on a tailnet as someone's", async () => {
    const host = machine({
      onTailnet: async () => ({ problem: "this machine is a tagged device" }),
    });
    const report = await up(443, host);
    expect(report).toMatchObject({ ok: false, address: null, owner: null });
    expect(report.steps).toEqual([
      {
        step: "tailscale",
        status: "fix",
        says: "Nothing changed: this machine is a tagged device.",
      },
    ]);
    expect(host.save).not.toHaveBeenCalled();
    expect(host.restartAsService).not.toHaveBeenCalled();
  });

  it("changes nothing where Tailscale serves something else on the port asked, and takes the door's again", async () => {
    const taken = machine({ served: async () => new Map([[443, "http://127.0.0.1:3773"]]) });
    const report = await up(443, taken);
    expect(report.ok).toBe(false);
    expect(report.owner).toBe(OWNER);
    expect(report.steps.at(-1)).toMatchObject({ step: "port", status: "fix" });
    expect(report.steps.at(-1)!.says).toContain("--port");
    expect(taken.save).not.toHaveBeenCalled();
    // Run again, on a machine already set up: the port is Auni's own.
    const again = machine({ served: async () => new Map([[443, doorRoute()]]) });
    expect((await up(443, again)).ok).toBe(true);
  });

  // As on a box whose 443 is another app's (T3 Code's, say): the address carries the port.
  it("asked no port, takes the next one free where 443 is taken, and says so in the address", async () => {
    const host = machine({
      served: async () =>
        new Map([
          [443, "http://127.0.0.1:3773"],
          [8443, "http://127.0.0.1:8080"],
        ]),
    });
    const report = await up(null, host);
    expect(report).toMatchObject({ ok: true, address: `https://${NAME}:8444` });
    expect(report.steps.find(({ step }) => step === "port")!.says).toBe(
      "Tailscale serves something else on port 443 here, so Auni takes port 8444.",
    );
    expect(host.save).toHaveBeenCalledWith(OWNER, `https://${NAME}:8444`);
    expect(host.serve).toHaveBeenCalledWith(expect.arrayContaining(["--https=8444"]));
  });

  it("keeps the port its door has, so running it again keeps the address", () => {
    const routes = new Map([
      [443, doorRoute()],
      [8444, doorRoute()],
    ]);
    expect(portFor(new Map(), null)).toBe(443);
    expect(portFor(new Map([[8444, doorRoute()]]), null)).toBe(8444);
    expect(portFor(routes, 8444)).toBe(8444);
    expect(portFor(new Map([[8601, "something"]]), 8601)).toBeNull();
  });

  it("stops at a service that won't install, saying why", async () => {
    const host = machine({
      restartAsService: async () => {
        throw new Error("Command failed: systemctl --user daemon-reload");
      },
    });
    const report = await up(443, host);
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toEqual({
      step: "service",
      status: "fix",
      says: "Auni couldn't run as a service of this machine: Command failed: systemctl --user daemon-reload",
    });
    expect(host.serve).not.toHaveBeenCalled();
  });

  it("says the command to run where serving the door takes root", async () => {
    const host = machine({ serve: async () => "root" as const });
    const report = await up(8601, host);
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toEqual({
      step: "serve",
      status: "fix",
      says: expect.stringContaining("once root says so"),
      run: `sudo tailscale serve --bg --https=8601 ${doorRoute()}`,
    });
    // What it could do, it did: the next run finds it done and goes on from there.
    expect(host.save).toHaveBeenCalledWith(OWNER, `https://${NAME}:8601`);
    expect(host.reaches).not.toHaveBeenCalled();
    expect(upSaid(report)).toContain(`Run: sudo tailscale serve --bg --https=8601 ${doorRoute()}`);
  });

  it("goes on once root has served the door, rather than asking for root again", async () => {
    const host = machine({
      served: async () => new Map([[8601, doorRoute()]]),
      serve: async () => "root" as const,
    });
    const report = await up(null, host);
    expect(report.ok).toBe(true);
    expect(report.steps.map(({ step, status }) => [step, status])).toContainEqual(["serve", "done"]);
    expect(report.address).toBe(`https://${NAME}:8601`);
  });

  it("says how to keep it running with nobody logged in, where that takes root", async () => {
    const report = await up(443, machine({ enableLinger: async () => false }));
    expect(report.ok).toBe(false);
    expect(report.steps.find(({ step }) => step === "linger")).toMatchObject({
      status: "fix",
      run: expect.stringMatching(/^sudo loginctl enable-linger /u),
    });
    // Off Linux, there is no lingering to turn on.
    const mac = await up(443, machine({ linux: false }));
    expect(mac.steps.map(({ step }) => step)).not.toContain("linger");
  });

  it("says plainly when the machine itself won't keep Auni running", async () => {
    const report = await up(
      443,
      machine({
        staysOn: async () => ({
          stays: false,
          laptop: true,
          says: "This is a laptop: Auni stops when the lid closes.",
        }),
      }),
    );
    // A laptop is a limit to know, not a step that failed.
    expect(report.ok).toBe(true);
    expect(upSaid(report)).toContain("note This is a laptop: Auni stops when the lid closes.");
  });
});
