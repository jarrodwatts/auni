import { describe, expect, it } from "vitest";

import { SETTINGS_SECTIONS, settingsSection } from "@/lib/app-links";

import { SETTINGS_SEARCH_ITEMS, SETTINGS_SECTIONS_META, searchSettings } from "./settings-search";

describe("settings search and navigation", () => {
  it("covers every settings section in sidebar metadata", () => {
    expect(SETTINGS_SECTIONS_META.map((s) => s.id)).toEqual([...SETTINGS_SECTIONS]);
  });

  it("maps legacy Settings URLs to their new sections", () => {
    expect(settingsSection("profile")).toBe("general");
    expect(settingsSection("machine")).toBe("remote");
    expect(settingsSection("help")).toBe("diagnostics");
    expect(settingsSection("remote")).toBe("remote");
    expect(settingsSection("unknown")).toBeNull();
    expect(settingsSection(null)).toBeNull();
  });

  it("matches multi-token queries across titles, descriptions, and keywords", () => {
    const tailscale = searchSettings("tailscale qr");
    expect(tailscale[0]?.section).toBe("remote");
    expect(tailscale[0]?.targetId).toBe("setting-tailscale");

    const dark = searchSettings("dark mode");
    expect(dark[0]?.section).toBe("appearance");

    const rpc = searchSettings("alchemy rpc");
    expect(rpc[0]?.section).toBe("network");

    const doctor = searchSettings("doctor fix");
    expect(doctor[0]?.section).toBe("diagnostics");

    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("zzzznotasetting")).toEqual([]);
  });

  it("points every search item at a valid settings section", () => {
    const valid = new Set<string>(SETTINGS_SECTIONS);
    for (const item of SETTINGS_SEARCH_ITEMS) {
      expect(valid.has(item.section)).toBe(true);
      expect(item.targetId.length).toBeGreaterThan(0);
    }
  });
});
