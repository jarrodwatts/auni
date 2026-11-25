import { describe, expect, it } from "vitest";

import { SETTINGS_SECTIONS, settingsDialogHref, settingsSection } from "@/lib/app-links";

import { SETTINGS_PANES, SETTINGS_SEARCH_ITEMS, searchSettings } from "./settings-search";

describe("Settings' panes and its search", () => {
  it("lists every pane, in order", () => {
    expect(SETTINGS_PANES.map(({ id }) => id)).toEqual([...SETTINGS_SECTIONS]);
  });

  it("opens links written before the panes were folded at the pane that holds them now", () => {
    expect(settingsSection("general")).toBe("you");
    expect(settingsSection("appearance")).toBe("you");
    expect(settingsSection("personalization")).toBe("you");
    expect(settingsSection("brains")).toBe("ai");
    expect(settingsSection("remote")).toBe("devices");
    expect(settingsSection("channels")).toBe("devices");
    expect(settingsSection("network")).toBe("health");
    expect(settingsSection("about")).toBe("health");
    expect(settingsSection("wallet")).toBe("wallet");
  });

  it("tells the list apart from a pane and from closed", () => {
    expect(settingsSection("open")).toBeNull();
    expect(settingsSection(null)).toBeUndefined();
    expect(settingsSection("nothing")).toBeUndefined();
    expect(settingsDialogHref("/app", "")).toBe("/app?settings=open");
    expect(settingsDialogHref("/app", "x=1", "remote")).toBe("/app?x=1&settings=devices");
  });

  it("finds a setting by the words an owner would use", () => {
    expect(searchSettings("tailscale")[0]?.target).toBe("setting-phone");
    expect(searchSettings("dark")[0]?.target).toBe("setting-look");
    expect(searchSettings("rpc")[0]?.target).toBe("setting-networks");
    expect(searchSettings("private key")[0]?.target).toBe("setting-keys");
    expect(searchSettings("telegram")[0]?.section).toBe("devices");
    expect(searchSettings("claude")[0]?.section).toBe("ai");
    expect(searchSettings("doctor")[0]?.target).toBe("setting-checks");
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("zzzz")).toEqual([]);
  });

  it("lands each result on its own place", () => {
    const targets = SETTINGS_SEARCH_ITEMS.map(({ target }) => target);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
