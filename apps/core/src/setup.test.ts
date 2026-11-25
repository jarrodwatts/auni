import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ON_WINDOWS } from "./agent/brain.ts";
import { nextStep, said, SETUP_STEPS, spareKey, tunnelHint, type SetupFacts } from "./setup.ts";

afterEach(() => vi.unstubAllEnvs());

/** A machine where everything the terminal does is done. */
const ready: SetupFacts = {
  platform: "ok",
  install: { version: "0.1.0", checkout: false, onPath: true },
  brains: {
    rows: [
      {
        id: "claude-code",
        name: "Claude Code",
        state: "ready",
        login: "your Claude Max plan",
        models: [],
      },
      { id: "codex", name: "Codex", state: "not-installed", fix: "npm install -g @openai/codex" },
    ],
    blocked: null,
  },
  running: { running: true, webAnswers: true, browser: "opened" },
  webBuilt: true,
  paired: true,
  tailscale: false,
};

/** A fresh install: no brain, nothing running. */
const fresh: SetupFacts = {
  ...ready,
  brains: {
    rows: [
      {
        id: "claude-code",
        name: "Claude Code",
        state: "signed-out",
        fix: "claude auth login",
      },
      { id: "codex", name: "Codex", state: "not-installed", fix: "npm install -g @openai/codex" },
    ],
    blocked: null,
  },
  running: { running: false, webAnswers: false, browser: null },
  paired: false,
};

describe("nextStep", () => {
  it("says the web app builds as Auni starts only where it isn't built yet", () => {
    const thinking: SetupFacts = { ...fresh, brains: ready.brains };
    // An install from install.sh comes built.
    expect(nextStep(thinking).say).toContain("its jobs and the web app, and runs while");
    expect(nextStep({ ...thinking, webBuilt: false }).say).toContain(
      "which builds the first time (about a minute)",
    );
    const starting = { ...thinking, running: { running: true, webAnswers: false, browser: null } };
    expect(nextStep(starting).say).not.toContain("builds");
    expect(nextStep({ ...starting, webBuilt: false }).say).toContain("builds for about a minute");
  });

  it("hands over at the browser once Auni runs there, signed in", () => {
    const answer = nextStep(ready);
    expect(answer).toMatchObject({ step: "done", next: "stop" });
    expect(answer.done).toEqual(SETUP_STEPS.slice(0, -1));
    expect(answer.say).toContain("takes it from there");
  });

  it("hands over at the tailnet address always on, where no browser pairs", () => {
    const answer = nextStep({ ...ready, paired: false, tailscale: true });
    expect(answer).toMatchObject({ step: "done", next: "stop" });
    expect(answer.say).toContain("signed in to your Tailscale account");
    expect(answer.say).not.toContain("auni pair");
  });

  it("stops on Windows itself, saying how to start inside WSL", () => {
    expect(nextStep({ ...fresh, platform: "windows" })).toMatchObject({
      step: "tools",
      next: "stop",
      say: ON_WINDOWS,
      done: [],
    });
  });

  // The web app signs a brain in, or installs it, from first run on: Auni starts first.
  it("goes on to start Auni where first run can make a brain ready, and says it does", () => {
    expect(nextStep(fresh)).toMatchObject({
      step: "start",
      next: "run",
      done: ["tools", "install"],
    });
    const expired = {
      ...fresh.brains,
      rows: [
        { id: "codex", name: "Codex", state: "expired" as const, fix: "codex login --device-auth" },
      ],
    };
    const handed = nextStep({ ...ready, brains: expired });
    expect(handed).toMatchObject({ step: "done", done: ["tools", "install", "start"] });
    expect(handed.say).toContain(
      "asks what you believe, and takes it from there, signing in your AI with you",
    );
  });

  it("tells the person each brain's fix where only they can make one ready, never running one", () => {
    const sandbox = {
      ...fresh.brains,
      rows: [
        {
          id: "claude-code",
          name: "Claude Code",
          state: "not-installed" as const,
          fix: "sudo apt-get install bubblewrap socat",
        },
      ],
    };
    const answer = nextStep({ ...fresh, brains: sandbox });
    expect(answer).toMatchObject({ step: "brain", next: "tell", done: ["tools", "install"] });
    expect(answer.say).toContain("- Claude Code: sudo apt-get install bubblewrap socat");
    expect(answer.run).toBeUndefined();
  });

  it("takes a brain resting at its usage limit as one that can think", () => {
    const resting = {
      ...fresh,
      brains: {
        rows: [
          {
            id: "claude-code",
            name: "Claude Code",
            state: "resting" as const,
            login: "your Claude Max plan",
            models: [],
            until: new Date(),
          },
        ],
        blocked: null,
      },
    };
    expect(nextStep(resting).step).toBe("start");
  });

  it("stops on a BRAIN that names no brain, which only the owner changes", () => {
    const answer = nextStep({
      ...fresh,
      brains: { rows: fresh.brains.rows, blocked: "BRAIN=gpt names no brain app." },
    });
    expect(answer).toMatchObject({ step: "brain", next: "stop" });
    expect(answer.say).toContain("BRAIN=gpt");
  });

  const thinking = { ...fresh, brains: ready.brains };

  it("starts Auni in the background, which opens the browser itself", () => {
    expect(nextStep(thinking)).toMatchObject({
      step: "start",
      next: "run",
      run: { command: "auni", background: true },
      done: ["tools", "install", "brain"],
    });
    // Running, but the web app is still building.
    expect(
      nextStep({ ...thinking, running: { running: true, webAnswers: false, browser: null } }),
    ).toMatchObject({ step: "start", next: "wait" });
  });

  it("runs the command as this machine reaches it, and says how to put it on the PATH", () => {
    const offPath = nextStep({
      ...thinking,
      install: { version: "0.1.0", checkout: false, onPath: false },
    });
    expect(offPath.run?.command).toBe("~/.local/bin/auni");
    expect(offPath.say).toContain('export PATH="$HOME/.local/bin:$PATH"');
    // A clone counts as installed, and runs through pnpm.
    const clone = nextStep({
      ...thinking,
      install: { version: "0.1.0", checkout: true, onPath: true },
    });
    expect(clone).toMatchObject({ step: "start", run: { command: "pnpm auni" } });
    expect(clone.done).toContain("install");
  });

  const up = (browser: SetupFacts["running"]["browser"]) =>
    nextStep({ ...thinking, running: { running: true, webAnswers: true, browser } });

  // Setup said "Auni opened in their browser" on a machine with no screen, where `auni` had
  // printed "Run `auni pair`" instead (2026-11-14).
  it("says what the running Auni did with the browser, never guessing", () => {
    // It hasn't tried yet: the web app came up a moment before it opens the browser.
    expect(up(null)).toMatchObject({ step: "start", next: "wait" });
    expect(up(null).say).not.toContain("opened");

    expect(up("opened")).toMatchObject({ step: "start", next: "tell" });
    expect(up("opened").say).toContain("Auni opened in your browser, signed in as you");

    for (const browser of ["no-screen", "not-opened", "ran-out"] as const) {
      const { say, run } = up(browser);
      expect(say).not.toContain("look for its tab");
      expect(say).toContain("run `auni pair` in your own terminal");
      expect(run).toBeUndefined();
    }
    // Only with no screen here does it say how a browser on another computer reaches this one.
    expect(up("no-screen").say).toContain("no screen");
    expect(up("not-opened").say).not.toContain("ssh");
  });

  it.each([undefined, "2001:db8::1 43210 2001:db8::2 2222"])(
    "gives headless JSON the same shell command as human setup (SSH_CONNECTION=%s)",
    (connection) => {
      vi.stubEnv("SSH_CONNECTION", connection);
      const facts: SetupFacts = {
        ...thinking,
        running: { running: true, webAnswers: true, browser: "no-screen" },
      };
      const { say, ...rest } = nextStep(facts);
      expect(rest).toEqual({
        step: "start",
        next: "tell",
        waitSeconds: 15,
        done: ["tools", "install", "brain"],
      });
      const command = say.match(/ssh -L [^\n`]+/u)?.[0];
      expect(command).toBeDefined();
      expect(() => execFileSync("sh", ["-n", "-c", command!])).not.toThrow();
      expect(command).toBe(said(facts).match(/ssh -L [^\n]+/u)?.[0]);
    },
  );

  it("speaks to the owner in every answer, leaving what the agent must never do to the skill", () => {
    const answers = [
      nextStep(fresh),
      nextStep(thinking),
      nextStep({ ...thinking, install: { version: "0.1.0", checkout: false, onPath: false } }),
      nextStep({ ...thinking, running: { running: true, webAnswers: false, browser: null } }),
      ...(["opened", "no-screen", "not-opened", "ran-out", null] as const).map(up),
      nextStep(ready),
    ];
    for (const { say } of answers) {
      expect(say).not.toMatch(/\b(they|them|their|theirs|the person|ask them)\b/iu);
      expect(say).not.toMatch(/never read/iu);
    }
  });

  it("gives the same answer for the same facts, and only grows what's done", () => {
    const facts: SetupFacts[] = [
      { ...fresh, platform: "windows" },
      fresh,
      thinking,
      { ...thinking, running: ready.running },
      ready,
    ];
    let before = -1;
    for (const each of facts) {
      expect(nextStep(each)).toEqual(nextStep(each));
      const { done } = nextStep(each);
      expect(done.length).toBeGreaterThanOrEqual(before);
      before = done.length;
    }
  });

  it("shows the tunnel before the pairing command when the other computer needs it", () => {
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 43210 192.0.2.2 22");
    const facts: SetupFacts = {
      ...thinking,
      running: { running: true, webAnswers: true, browser: "no-screen" },
    };
    const output = said(facts);
    expect(output).toContain(`ssh -L 3000:127.0.0.1:3000 ${userInfo().username}@192.0.2.2`);
    expect(output.indexOf("ssh -L")).toBeLessThan(output.indexOf("Run auni pair"));
    expect(said({ ...facts, running: { ...facts.running, browser: "not-opened" } })).not.toContain(
      "ssh -L",
    );
  });

  it("uses the SSH server's IPv6 address and custom port when known", () => {
    vi.stubEnv("SSH_CONNECTION", "2001:db8::1 43210 2001:db8::2 2222");
    expect(tunnelHint()).toContain(
      `ssh -L 3000:127.0.0.1:3000 -p 2222 ${userInfo().username}@2001:db8::2\n` +
        "If that address doesn't work from your computer, add -L as shown to your usual SSH command.\n",
    );
  });

  it("explains the placeholder when the SSH address is unknown", () => {
    vi.stubEnv("SSH_CONNECTION", undefined);
    const hint = tunnelHint();
    expect(hint).toContain("ssh -L 3000:127.0.0.1:3000 ssh-host\n");
    expect(hint).toContain("Replace ssh-host with the address or user@host");
    expect(hint).toContain("Leave that SSH session open");
  });

  it("reads as plain words, with the command to run", () => {
    expect(said(thinking)).toMatch(/^Auni isn't running\.\nRun auni/u);
    expect(said({ ...thinking, webBuilt: false })).toContain(
      "The web app builds on the first start (about a minute).",
    );
    expect(nextStep(thinking).run).toEqual({ command: "auni", background: true });
  });
});

describe("the spare key", () => {
  const none = { backupSavedAt: null, backupLaterAt: null };
  const at = new Date("2026-11-17T00:00:00Z");

  it("waits for a first trade to go through, then is due", () => {
    expect(spareKey(none, false)).toBe("not-yet");
    expect(spareKey(none, true)).toBe("due");
  });

  it("is asked no more once saved, or put off for later", () => {
    expect(spareKey({ ...none, backupSavedAt: at }, true)).toBe("saved");
    expect(spareKey({ ...none, backupLaterAt: at }, true)).toBe("later");
    expect(spareKey({ backupSavedAt: at, backupLaterAt: at }, true)).toBe("saved");
  });
});
