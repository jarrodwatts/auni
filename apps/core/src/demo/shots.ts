import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ShotLook = "light" | "dark";

export const SHOT_WIDTHS = [
  { name: "desktop", width: 1280, height: 860 },
  { name: "phone", width: 390, height: 844 },
] as const;

export type ShotSize = (typeof SHOT_WIDTHS)[number]["name"];

const SCREEN_SUFFIX = new RegExp(
  `^(?:${SHOT_WIDTHS.map((width) => width.name).join("|")})(?:\\.\\d+)?\\.png$`,
  "u",
);

/** Where a look's pictures live: light sits in `root`, dark in `root/dark`. */
export function shotLookDir(root: string, look: ShotLook): string {
  return look === "light" ? root : join(root, look);
}

/** Whether `file` is one of `name`'s pictures (`<name>.<size>[.<part>].png`). */
function belongsToScreen(file: string, name: string): boolean {
  const prefix = `${name}.`;
  return file.startsWith(prefix) && SCREEN_SUFFIX.test(file.slice(prefix.length));
}

interface ShotScreen {
  /** Writes one window of this screen and returns its file name. */
  save(size: ShotSize, part: number, bytes: Uint8Array): string;
  /** Removes leftover windows or widths of this screen that this run didn't write. */
  finish(): void;
}

export interface ShotFolder {
  /** Opens one screen so its pictures can be written and any old extra windows cleaned up. */
  screen(name: string): ShotScreen;
  /**
   * Finishes the look: when `prune` is set (a full run of this look), removes every PNG directly
   * in this folder that this run didn't write, leaving other looks' folders and non-PNG files
   * alone. On a subset run (`prune: false`), keeps every other screen as it was.
   */
  finish(): void;
}

/**
 * Manages one look's screenshot folder. Nothing is wiped up front, so retaking one look or a
 * subset of screens replaces only those pictures and an interrupted run leaves earlier pictures
 * intact.
 */
export function openShotFolder(dir: string, { prune }: { prune: boolean }): ShotFolder {
  const written = new Set<string>();
  let created = false;

  return {
    screen(name) {
      const kept = new Set<string>();
      return {
        save(size, part, bytes) {
          if (!created) {
            mkdirSync(dir, { recursive: true });
            created = true;
          }
          const file = `${name}.${size}${part === 1 ? "" : `.${part}`}.png`;
          writeFileSync(join(dir, file), bytes);
          written.add(file);
          kept.add(file);
          return file;
        },
        finish() {
          if (kept.size === 0 || !existsSync(dir)) return;
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && belongsToScreen(entry.name, name) && !kept.has(entry.name)) {
              rmSync(join(dir, entry.name));
            }
          }
        },
      };
    },
    finish() {
      if (!prune || !existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".png") && !written.has(entry.name)) {
          rmSync(join(dir, entry.name));
        }
      }
    },
  };
}
