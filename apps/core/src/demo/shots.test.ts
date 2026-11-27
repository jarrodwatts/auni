import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { openShotFolder, shotLookDir } from "./shots.ts";

function pngsIn(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, readFileSync(join(dir, entry.name), "utf8")] as const)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

describe("demo screenshot output folder", () => {
  it("replaces only the retaken screen on a subset run and keeps every other picture", () => {
    const root = tempDir("auni-shots-subset-");
    const dark = shotLookDir(root, "dark");
    mkdirSync(dark, { recursive: true });
    writeFileSync(join(root, "money.desktop.png"), "old-money-desktop");
    writeFileSync(join(root, "money.desktop.2.png"), "stale-money-part-2");
    writeFileSync(join(root, "money.desktop.3.png"), "stale-money-part-3");
    writeFileSync(join(root, "money.phone.png"), "old-money-phone");
    writeFileSync(join(root, "money-take.desktop.png"), "keep-money-take");
    writeFileSync(join(root, "money-take.desktop.2.png"), "keep-money-take-2");
    writeFileSync(join(root, "apps.desktop.png"), "keep-apps");
    writeFileSync(join(dark, "money.desktop.png"), "keep-dark-money");
    writeFileSync(join(dark, "apps.desktop.png"), "keep-dark-apps");

    const light = openShotFolder(shotLookDir(root, "light"), { prune: false });
    const money = light.screen("money");
    expect(money.save("desktop", 1, Buffer.from("new-money-desktop"))).toBe("money.desktop.png");
    expect(money.save("phone", 1, Buffer.from("new-money-phone"))).toBe("money.phone.png");
    money.finish();
    light.finish();

    expect(pngsIn(root)).toEqual({
      "apps.desktop.png": "keep-apps",
      "money-take.desktop.2.png": "keep-money-take-2",
      "money-take.desktop.png": "keep-money-take",
      "money.desktop.png": "new-money-desktop",
      "money.phone.png": "new-money-phone",
    });
    expect(pngsIn(dark)).toEqual({
      "apps.desktop.png": "keep-dark-apps",
      "money.desktop.png": "keep-dark-money",
    });
  });

  it("drops a stale width when a retaken screen becomes phone-only", () => {
    const root = tempDir("auni-shots-width-");
    writeFileSync(join(root, "chats.desktop.png"), "old-desktop");
    writeFileSync(join(root, "chats.phone.png"), "old-phone");
    writeFileSync(join(root, "chats.notes.png"), "not-a-shot");

    const folder = openShotFolder(shotLookDir(root, "light"), { prune: false });
    const chats = folder.screen("chats");
    chats.save("phone", 1, Buffer.from("new-phone"));
    chats.finish();
    folder.finish();

    expect(pngsIn(root)).toEqual({
      "chats.notes.png": "not-a-shot",
      "chats.phone.png": "new-phone",
    });
  });

  it("clears stale light pictures on a full light run without touching dark or non-PNG files", () => {
    const root = tempDir("auni-shots-light-");
    const dark = shotLookDir(root, "dark");
    mkdirSync(dark, { recursive: true });
    writeFileSync(join(root, "money.desktop.png"), "old-money");
    writeFileSync(join(root, "removed-screen.desktop.png"), "stale");
    writeFileSync(join(root, "notes.txt"), "keep-notes");
    writeFileSync(join(dark, "money.desktop.png"), "keep-dark-money");
    writeFileSync(join(dark, "removed-screen.desktop.png"), "keep-dark-until-dark-runs");

    const light = openShotFolder(shotLookDir(root, "light"), { prune: true });
    const money = light.screen("money");
    money.save("desktop", 1, Buffer.from("new-money"));
    money.finish();
    light.finish();

    expect(pngsIn(root)).toEqual({
      "money.desktop.png": "new-money",
      "notes.txt": "keep-notes",
    });
    expect(pngsIn(dark)).toEqual({
      "money.desktop.png": "keep-dark-money",
      "removed-screen.desktop.png": "keep-dark-until-dark-runs",
    });
  });

  it("clears stale dark pictures on a full dark run without touching light", () => {
    const root = tempDir("auni-shots-dark-");
    const dark = shotLookDir(root, "dark");
    mkdirSync(dark, { recursive: true });
    writeFileSync(join(root, "money.desktop.png"), "keep-light-money");
    writeFileSync(join(dark, "money.desktop.png"), "old-dark-money");
    writeFileSync(join(dark, "removed-screen.desktop.png"), "stale-dark");

    const folder = openShotFolder(dark, { prune: true });
    const money = folder.screen("money");
    money.save("desktop", 1, Buffer.from("new-dark-money"));
    money.finish();
    folder.finish();

    expect(pngsIn(root)).toEqual({
      "money.desktop.png": "keep-light-money",
    });
    expect(pngsIn(dark)).toEqual({
      "money.desktop.png": "new-dark-money",
    });
  });

  it("leaves earlier pictures intact if a full run stops before finishing", () => {
    const root = tempDir("auni-shots-aborted-");
    writeFileSync(join(root, "money.desktop.png"), "old-money");
    writeFileSync(join(root, "apps.desktop.png"), "old-apps");

    const light = openShotFolder(shotLookDir(root, "light"), { prune: true });
    const money = light.screen("money");
    money.save("desktop", 1, Buffer.from("new-money"));
    money.finish();
    // Run stopped before light.finish().

    expect(pngsIn(root)).toEqual({
      "apps.desktop.png": "old-apps",
      "money.desktop.png": "new-money",
    });
  });

  it("creates nothing when a subset run matches no screens", () => {
    const root = join(tempDir("auni-shots-empty-"), "out");

    const light = openShotFolder(shotLookDir(root, "light"), { prune: false });
    light.finish();

    expect(existsSync(root)).toBe(false);
  });
});
