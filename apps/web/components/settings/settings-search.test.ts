import { describe, expect, it } from "vitest";

import { SETTINGS_SECTIONS, settingsAsked, settingsDialogHref } from "@/lib/app-links";

import { SETTINGS_PANES, SETTINGS_SEARCH_ITEMS, searchSettings } from "./settings-search";

describe("Settings' panes and its search", () => {
  it("lists every pane, in order", () => {
    expect(SETTINGS_PANES.map(({ id }) => id)).toEqual([...SETTINGS_SECTIONS]);
  });

  it("opens links written before the panes were folded at the pane that holds them now", () => {
    const pane = (value: string) => settingsAsked(value)?.section;
    expect(pane("general")).toBe("you");
    expect(pane("appearance")).toBe("you");
    expect(pane("personalization")).toBe("you");
    expect(pane("brains")).toBe("ai");
    expect(pane("remote")).toBe("devices");
    expect(pane("channels")).toBe("devices");
    expect(pane("network")).toBe("health");
    expect(pane("about")).toBe("health");
    expect(settingsAsked("wallet")).toEqual({ section: "wallet", target: null });
  });

  // An old ?settings=network link opened Health with Networks folded away (2026-11-25).
  it("lands an old link on the setting it named, which the search finds in that pane", () => {
    expect(settingsAsked("network")).toEqual({ section: "health", target: "setting-networks" });
    expect(settingsAsked("remote")?.target).toBe("setting-phone");
    const lands = ["general", "profile", "appearance", "personalization", "brains", "channels"]
      .concat(["remote", "machine", "network", "diagnostics", "help", "about"])
      .map((name) => settingsAsked(name)!)
      .filter(({ target }) => target !== null);
    expect(lands.length).toBeGreaterThan(5);
    for (const { section, target } of lands)
      expect(SETTINGS_SEARCH_ITEMS).toContainEqual(expect.objectContaining({ section, target }));
  });

  it("tells the list apart from a pane and from closed", () => {
    expect(settingsAsked("open")).toEqual({ section: null, target: null });
    expect(settingsAsked(null)).toBeUndefined();
    expect(settingsAsked("nothing")).toBeUndefined();
    expect(settingsAsked("toString")).toBeUndefined();
    expect(settingsDialogHref("/app", "")).toBe("/app?settings=open");
    expect(settingsDialogHref("/app", "x=1", "remote")).toBe("/app?x=1&settings=remote");
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
