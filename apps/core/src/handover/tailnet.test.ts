import { describe, expect, it } from "vitest";

import { readTailnet, tailnetIn } from "./tailnet.ts";

// `tailscale status --json` as Tailscale 1.104 prints it, cut to the fields read, with made-up
// names and addresses.
const OWNER = 1111;
const node = (fields: Record<string, unknown>) => ({
  UserID: OWNER,
  Online: true,
  OS: "linux",
  ...fields,
});
const printed = JSON.stringify({
  BackendState: "Running",
  Self: node({
    ID: "nSELF",
    HostName: "Ada's MacBook",
    DNSName: "adas-macbook.tail1234.ts.net.",
    OS: "macOS",
    TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
  }),
  Peer: {
    "nodekey:a": node({
      ID: "nBOX",
      HostName: "box",
      DNSName: "box.tail1234.ts.net.",
      TailscaleIPs: ["100.64.0.2"],
    }),
    "nodekey:b": node({
      ID: "nPHONE",
      HostName: "localhost",
      DNSName: "iphone15.tail1234.ts.net.",
      OS: "iOS",
      TailscaleIPs: ["100.64.0.3"],
      Online: false,
    }),
    "nodekey:c": node({
      ID: "nFRIEND",
      HostName: "friend",
      DNSName: "friend.tail1234.ts.net.",
      UserID: 2222,
      TailscaleIPs: ["100.64.0.4"],
    }),
    "nodekey:d": node({
      ID: "nTAGGED",
      HostName: "ci",
      DNSName: "ci.tail1234.ts.net.",
      Tags: ["tag:server"],
      TailscaleIPs: ["100.64.0.5"],
    }),
    "nodekey:e": node({
      ID: "nSHARED",
      HostName: "shared",
      DNSName: "shared.other.ts.net.",
      ShareeNode: true,
      TailscaleIPs: ["100.64.0.6"],
    }),
  },
});

describe("the owner's machines", () => {
  it("lists this one first, then the owner's own, with their OS and whether they're online", () => {
    const tailnet = tailnetIn(printed);
    expect(tailnet.state).toBe("on");
    if (tailnet.state !== "on") return;
    expect(tailnet.here.name).toBe("adas-macbook");
    expect(tailnet.machines).toEqual([
      expect.objectContaining({ id: "nSELF", here: true, online: true, os: "macOS" }),
      {
        id: "nBOX",
        name: "box",
        os: "linux",
        online: true,
        runsAuni: true,
        dnsName: "box.tail1234.ts.net",
        ips: ["100.64.0.2"],
        here: false,
      },
      expect.objectContaining({ id: "nPHONE", name: "iphone15", online: false, runsAuni: false }),
    ]);
  });

  it("says Tailscale is off when it isn't connected, and missing when it isn't here", async () => {
    expect(tailnetIn(JSON.stringify({ BackendState: "NeedsLogin", Self: null }))).toEqual({
      state: "off",
    });
    expect(tailnetIn("")).toEqual({ state: "off" });
    expect(await readTailnet(() => Promise.resolve(null))).toEqual({ state: "missing" });
    // On a Mac, the command inside Tailscale's app, when none is on the PATH.
    const asked: string[] = [];
    const found = await readTailnet((command) => {
      asked.push(command);
      return Promise.resolve(command.startsWith("/Applications") ? printed : null);
    });
    expect(found.state).toBe("on");
    expect(asked).toHaveLength(2);
  });
});
