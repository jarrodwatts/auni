import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import type { AppAbout } from "@auni/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp } from "./apps/contract.ts";
import { PrivateFieldRefused } from "./private-fields.ts";
import {
  appsOff,
  ownedBy,
  readSettings,
  requiredSetting,
  savePreferredBrain,
  saveRpcUrl,
  saveSetting,
  saveSwitch,
  setBy,
  setting,
  settingFields,
  settingsChanged,
} from "./settings.ts";

// A chat app as an app folder would declare it: a token the owner types, a URL only the settings
// file may set, and a secret named as one of core's own settings, which its id doesn't own.
const CHAT = {
  id: "fake-chat",
  name: "Fake Chat",
  settings: {
    token: { env: "FAKE_CHAT_TOKEN", label: "Fake Chat bot token", kind: "secret" },
    apiUrl: { env: "FAKE_CHAT_API_URL", label: "Fake Chat API URL", kind: "file" },
    stolen: { env: "RPC_URL_BASE", label: "Not its own", kind: "secret" },
  },
} as const satisfies AppAbout;

vi.mock(import("./apps/index.generated.ts"), async (original) => {
  const generated = await original();
  return { ...generated, APPS: [...generated.APPS, defineApp({ about: CHAT })] as never };
});

const TOKEN = "FAKE_CHAT_TOKEN";
/** A secret no assertion message or file listing may ever carry by accident. */
const SECRET = "7301:AAH-secret_token.value";

let home: string;
const file = () => join(home, ".env");
const text = () => readFileSync(file(), "utf8");
const real = process.env.AUNI_HOME;

// A save asks the registry which names are an app's own, and the first ask loads every app:
// seconds when the whole suite runs at once, which no single test should have to fit in.
beforeAll(async () => void (await import("./apps/registry.ts")), 60_000);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "auni-settings-"));
  process.env.AUNI_HOME = home;
  delete process.env[TOKEN];
  delete process.env.APPS_OFF;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env.AUNI_HOME = real;
  delete process.env[TOKEN];
  delete process.env.APPS_OFF;
});

/** The owner's file as they might have written it by hand, every line of which a save must keep. */
const BY_HAND = [
  "# Auni's settings. Lines starting with # are notes.",
  "export WALLET='local-key'",
  'RPC_URL_BASE="https://base.example/rpc?key=abc#frag"',
  "",
  "  JUPITER_API_KEY = spaced-out # with a note",
  "# FAKE_CHAT_TOKEN=an old one, commented out",
  "LAST=line with no newline after it",
].join("\n");

describe("saveSetting", () => {
  it("writes the one setting, in use at once, and leaves every other line as it was", async () => {
    writeFileSync(file(), BY_HAND);
    await saveSetting(TOKEN, SECRET);

    expect(text()).toBe(`${BY_HAND}\n${TOKEN}='${SECRET}'\n`);
    expect(parseEnv(text())).toEqual({ ...parseEnv(BY_HAND), [TOKEN]: SECRET });
    expect(setting(CHAT, "token")).toBe(SECRET);
    // The owner alone reads it, and nothing is left beside it.
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual([".env"]);
  });

  it("replaces the setting where it stands, once, however often the file set it", async () => {
    writeFileSync(file(), `A=1\n${TOKEN}=first\nB=2\nexport ${TOKEN} = "second"\nC=3\n`);
    await saveSetting(TOKEN, SECRET);
    expect(text()).toBe(`A=1\n${TOKEN}='${SECRET}'\nB=2\nC=3\n`);
    await saveSetting(TOKEN, "another");
    expect(text()).toBe(`A=1\n${TOKEN}='another'\nB=2\nC=3\n`);
  });

  it("makes the file, for the owner alone, when there is none", async () => {
    rmSync(home, { recursive: true });
    await saveSetting(TOKEN, `  ${SECRET}\n`);
    // What surrounds a pasted key goes; the key is kept whole.
    expect(text()).toBe(`${TOKEN}='${SECRET}'\n`);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("keeps every character a key may hold as itself", async () => {
    const all = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) =>
      String.fromCharCode(0x20 + index),
    )
      .join("")
      .replace("'", "")
      .trim();
    await saveSetting(TOKEN, all);
    expect(parseEnv(text())).toEqual({ [TOKEN]: all });
  });

  it.each([
    ["a line break, which would start a second setting", "x\nRPC_URL_BASE=https://evil.example"],
    ["a carriage return", "x\rRPC_URL_BASE=https://evil.example"],
    ["a NUL", "x\0y"],
    ["a single quote, which would end the value early", "x' RPC_URL_BASE='https://evil.example"],
    ["a tab", "x\ty"],
    ["a character that can't be seen", "x​y"],
    ["a letter outside ASCII", "kéy"],
    ["nothing", "   "],
  ])("refuses a value holding %s, and never repeats it", async (_what, value) => {
    writeFileSync(file(), BY_HAND);
    const refusal = await saveSetting(TOKEN, value).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PrivateFieldRefused);
    if (value.trim()) {
      expect((refusal as Error).message).not.toContain(value.trim());
      // It is what was pasted that is wrong, so the owner is told to paste again, and never sent
      // to edit a settings file that is fine.
      expect((refusal as Error).message).toMatch(/doesn't look like a key/u);
    }
    expect(text()).toBe(BY_HAND);
    expect(process.env[TOKEN]).toBeUndefined();
  });

  it.each([
    ["one of core's own", "RPC_URL_BASE"],
    ["the wallet Auni signs with", "WALLET"],
    ["the secret that seals cards", "TURN_TOKEN_SECRET"],
    ["where Auni keeps its data", "AUNI_HOME"],
    ["one an app declares for the settings file alone", "FAKE_CHAT_API_URL"],
    ["one no app declares", "FAKE_CHAT_OTHER"],
    ["one that isn't a variable's name", `${TOKEN}=x\nWALLET`],
  ])("refuses to write %s, whatever is asked", async (_what, name) => {
    writeFileSync(file(), BY_HAND);
    const before = process.env[name];
    await expect(saveSetting(name, "https://evil.example")).rejects.toThrow(/not a setting/u);
    expect(text()).toBe(BY_HAND);
    expect(process.env[name]).toBe(before);
  });

  it("refuses a file it can't change by one setting alone, and leaves it be", async () => {
    // The old value runs over two lines, and its second would read as a setting of its own once
    // the first is replaced: a wallet the owner never chose.
    const odd = `${TOKEN}="one\nWALLET=privy"\nBRAIN=codex\n`;
    writeFileSync(file(), odd);
    await expect(saveSetting(TOKEN, SECRET)).rejects.toThrow(PrivateFieldRefused);
    expect(text()).toBe(odd);
    expect(readdirSync(home)).toEqual([".env"]);
    expect(process.env[TOKEN]).toBeUndefined();
  });

  it("tells a loop that read its settings to start again, once for each save", async () => {
    const before = settingsChanged();
    expect(before.aborted).toBe(false);
    await saveSetting(TOKEN, SECRET);
    expect(before.aborted).toBe(true);
    expect(settingsChanged().aborted).toBe(false);
    // A save that was refused changed nothing, so nothing starts again.
    const after = settingsChanged();
    await saveSetting(TOKEN, "x\ny").catch(() => undefined);
    expect(after.aborted).toBe(false);
  });
});

describe("an app's secret", () => {
  it("is its own only under a name that starts with its id", () => {
    expect(ownedBy({ id: "elfa" }, "ELFA_AUTO_API_KEY")).toBe(true);
    expect(ownedBy({ id: "claude-code" }, "CLAUDE_CODE_KEY")).toBe(true);
    expect(ownedBy({ id: "elfa" }, "ELFAX_KEY")).toBe(false);
    expect(ownedBy({ id: "elfa" }, "RPC_URL_BASE")).toBe(false);
  });

  it("is typed into a private field, which no setting for the file alone has", async () => {
    const ids = (await settingFields()).map(({ id }) => id);
    expect(ids).toContain("keys:fake-chat");
    expect(ids).toContain("keys:elfa");
    const chat = (await settingFields()).find(({ id }) => id === "keys:fake-chat")!;
    expect(chat.inputs.map(({ name }) => name)).toEqual(["token"]);
  });

  it("is checked without being kept, then saved", async () => {
    const field = (await settingFields()).find(({ id }) => id === "keys:fake-chat")!;
    expect(field).toMatchObject({
      label: "Fake Chat bot token",
      inputs: [
        { name: "token", label: "Fake Chat bot token", placeholder: "Paste it here", set: false },
      ],
      confirms: false,
      proof: false,
    });
    const checked = await field.check({ token: SECRET });
    expect(JSON.stringify(checked)).not.toContain(SECRET);
    expect(process.env[TOKEN]).toBeUndefined();
    await expect(field.check({ token: "x\ny" })).rejects.toThrow(PrivateFieldRefused);
    await field.accept({ token: SECRET });
    expect(setting(CHAT, "token")).toBe(SECRET);
  });
});

describe("saveSwitch", () => {
  it("turns an app off and on again in the one line, and leaves every other line as it was", async () => {
    writeFileSync(file(), BY_HAND);
    const { offered } = await import("./apps/registry.ts");
    const on = () => offered().map(({ about }) => about.id);
    expect(on()).toEqual(expect.arrayContaining(["aave", "elfa"]));

    await saveSwitch("elfa", false);
    await saveSwitch("aave", false);
    expect(text()).toBe(`${BY_HAND}\nAPPS_OFF='aave,elfa'\n`);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect([...appsOff()]).toEqual(["aave", "elfa"]);
    expect(on()).not.toContain("elfa");
    expect(on()).not.toContain("aave");

    await saveSwitch("elfa", true);
    await saveSwitch("aave", true);
    expect(text()).toBe(`${BY_HAND}\nAPPS_OFF=''\n`);
    expect(parseEnv(text())).toEqual({ ...parseEnv(BY_HAND), APPS_OFF: "" });
    expect(on()).toEqual(expect.arrayContaining(["aave", "elfa"]));
  });

  it("ends the loops that read which apps are on as they start", async () => {
    const before = settingsChanged();
    await saveSwitch("telegram", false);
    expect(before.aborted).toBe(true);
    expect(settingsChanged().aborted).toBe(false);
  });

  // The wallet, a brain, a bridge, a swap route: core's own work runs on each, so none has a
  // switch, and neither has an app the owner doesn't act through or an id no app has.
  it.each(["local-key", "privy", "claude-code", "codex", "across", "lifi", "jupiter", "prices"])(
    "refuses %s, which has no switch, and writes nothing",
    async (id) => {
      await expect(saveSwitch(id, false)).rejects.toThrow(/can turn on or off/u);
      expect(readdirSync(home)).toEqual([]);
      expect(process.env.APPS_OFF).toBeUndefined();
    },
  );

  it.each(["nobody", "aave,local-key", "aave'\nWALLET='privy", ""])(
    "refuses %j, which is no app's id",
    async (id) => {
      await expect(saveSwitch(id, false)).rejects.toThrow(/can turn on or off/u);
      expect(readdirSync(home)).toEqual([]);
    },
  );

  // A line the owner wrote by hand can name anything; only an app with a switch is ever left out.
  it("never leaves out an app core runs on, whatever the file says", async () => {
    process.env.APPS_OFF = "local-key, across ,claude-code,lifi,elfa,nobody";
    const { offered, apps } = await import("./apps/registry.ts");
    const all = apps().map(({ about }) => about.id);
    expect(offered().map(({ about }) => about.id)).toEqual(all.filter((id) => id !== "elfa"));
    // A save keeps only the ids that have a switch, so the line never grows names it can't mean.
    await saveSwitch("aave", false);
    expect(parseEnv(text()).APPS_OFF).toBe("aave,elfa");
  });
});

// Jupiter's refusal said "JUPITER_API_KEY is not set", and the AI read the variable's name out.
describe("requiredSetting", () => {
  it("says what is missing and where it goes, never the variable's name", async () => {
    expect(() => requiredSetting(CHAT, "token")).toThrow(
      "Fake Chat isn't set up yet: it needs its Fake Chat bot token, which goes in on its page under Apps.",
    );
    expect(() => requiredSetting(CHAT, "apiUrl")).toThrow(
      "Fake Chat isn't set up yet: it needs its Fake Chat API URL, which goes in Auni's settings file.",
    );
    await saveSetting(TOKEN, SECRET);
    expect(requiredSetting(CHAT, "token")).toBe(SECRET);
  });
});

describe("setBy", () => {
  it("says where a setting's value comes from, and never the value", async () => {
    expect(setBy(TOKEN)).toBeNull();
    await saveSetting(TOKEN, SECRET);
    expect(setBy(TOKEN)).toBe("file");

    // After a restart: the saved value comes back from the file, beside one the environment set.
    delete process.env[TOKEN];
    process.env.FAKE_CHAT_API_URL = "https://environment.example";
    try {
      vi.resetModules();
      const started = await import("./settings.ts");
      started.readSettings();
      expect(started.setBy("FAKE_CHAT_API_URL")).toBe("environment");
      expect(started.setBy(TOKEN)).toBe("file");
    } finally {
      delete process.env.FAKE_CHAT_API_URL;
    }
  });
});

describe("readSettings", () => {
  /** settings.ts as a process that just started has it: it remembers nothing of the environment yet. */
  const fresh = async () => {
    vi.resetModules();
    return import("./settings.ts");
  };

  it("loads the file under what the environment sets, an empty variable setting nothing", () => {
    writeFileSync(file(), `${TOKEN}='from the file'\nFAKE_CHAT_API_URL='https://file.example'\n`);
    process.env.FAKE_CHAT_API_URL = "https://environment.example";
    process.env[TOKEN] = "";
    try {
      readSettings();
      expect(process.env[TOKEN]).toBe("from the file");
      expect(process.env.FAKE_CHAT_API_URL).toBe("https://environment.example");
    } finally {
      delete process.env.FAKE_CHAT_API_URL;
    }
  });

  it("reads a file a save wrote as the value saved, after a restart", async () => {
    await saveSetting(TOKEN, SECRET);
    delete process.env[TOKEN];
    (await fresh()).readSettings();
    expect(process.env[TOKEN]).toBe(SECRET);
  });

  it("has a save refuse a setting this computer's environment sets itself", async () => {
    process.env[TOKEN] = "from the environment";
    const started = await fresh();
    started.readSettings();
    // The class is this fresh copy's own, so the refusal is known by its fixed words.
    await expect(started.saveSetting(TOKEN, SECRET)).rejects.toThrow(
      `This computer's environment sets ${TOKEN} itself`,
    );
    expect(process.env[TOKEN]).toBe("from the environment");
    expect(readdirSync(home)).toEqual([]);
    // The fresh copy loads every app again to ask whose the name is.
  }, 60_000);

  it("has the switch refuse a list this computer's environment sets itself", async () => {
    process.env.APPS_OFF = "elfa";
    const started = await fresh();
    started.readSettings();
    await expect(started.saveSwitch("elfa", true)).rejects.toThrow(
      "This computer's environment sets APPS_OFF itself",
    );
    expect(process.env.APPS_OFF).toBe("elfa");
    expect(readdirSync(home)).toEqual([]);
  }, 60_000);
});

describe("local system settings writers", () => {
  afterEach(() => {
    delete process.env.BRAIN;
    delete process.env.RPC_URL_BASE;
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.TAILSCALE_OWNER;
    delete process.env.WEB_ORIGIN;
  });

  it("saves and clears a valid preferred brain, refusing unknown ids", async () => {
    await expect(savePreferredBrain("not-a-brain")).rejects.toThrow(PrivateFieldRefused);
    await savePreferredBrain("codex");
    expect(process.env.BRAIN).toBe("codex");
    expect(parseEnv(text()).BRAIN).toBe("codex");
    await savePreferredBrain(null);
    expect(process.env.BRAIN).toBe("");
  });

  it("validates and saves custom RPC URLs (HTTPS or localhost HTTP only)", () => {
    expect(() => saveRpcUrl("base", "http://example.com")).toThrow(PrivateFieldRefused);
    expect(() => saveRpcUrl("base", "not-a-url")).toThrow(PrivateFieldRefused);
    saveRpcUrl("base", "https://rpc.example.com/");
    expect(process.env.RPC_URL_BASE).toBe("https://rpc.example.com/");
    saveRpcUrl("base", "http://127.0.0.1:8545");
    expect(process.env.RPC_URL_BASE).toBe("http://127.0.0.1:8545");
    saveRpcUrl("base", null);
    expect(process.env.RPC_URL_BASE).toBe("");
  });

  it("saves and clears ALCHEMY_API_KEY and always-on settings", async () => {
    const prevAlchemy = process.env.ALCHEMY_API_KEY;
    delete process.env.ALCHEMY_API_KEY;
    try {
      vi.resetModules();
      const started = await import("./settings.ts");
      started.readSettings();
      started.saveAlchemyKey("alc_test_123");
      expect(process.env.ALCHEMY_API_KEY).toBe("alc_test_123");
      started.saveAlchemyKey(null);
      expect(process.env.ALCHEMY_API_KEY).toBe("");

      started.saveAlwaysOn("owner@example.com", "https://box.ts.net");
      expect(process.env.TAILSCALE_OWNER).toBe("owner@example.com");
      started.clearAlwaysOn();
      expect(process.env.TAILSCALE_OWNER).toBe("");
      expect(process.env.WEB_ORIGIN).toBe("");
    } finally {
      if (prevAlchemy === undefined) delete process.env.ALCHEMY_API_KEY;
      else process.env.ALCHEMY_API_KEY = prevAlchemy;
    }
  });

  it("never partially writes always-on auth settings when WEB_ORIGIN is locked by the host environment", async () => {
    writeFileSync(join(home, ".env"), "TAILSCALE_OWNER='owner@example.com'\n");
    process.env.WEB_ORIGIN = "https://box.ts.net";
    delete process.env.TAILSCALE_OWNER;
    vi.resetModules();
    const started = await import("./settings.ts");
    started.readSettings();
    expect(process.env.TAILSCALE_OWNER).toBe("owner@example.com");

    expect(() => started.clearAlwaysOn()).toThrow("This computer's environment sets WEB_ORIGIN");
    // TAILSCALE_OWNER must remain untouched on disk and in process.env.
    expect(process.env.TAILSCALE_OWNER).toBe("owner@example.com");
    expect(parseEnv(text()).TAILSCALE_OWNER).toBe("owner@example.com");
  });
});
