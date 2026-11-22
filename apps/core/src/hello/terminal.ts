import { writeSync } from "node:fs";

/**
 * Writes `text` to the terminal (fd 1) at once: false, and nothing written, once the terminal is
 * gone, its window closed (EIO) or its reader gone (EPIPE), as when the owner closes the window
 * while the scene plays. Then there is nothing left to draw on, and Auni still has to stop.
 */
export function toTerminal(text: string | Uint8Array): number | false {
  try {
    return typeof text === "string" ? writeSync(1, text) : writeSync(1, text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EIO" || code === "EPIPE") return false;
    throw error;
  }
}
