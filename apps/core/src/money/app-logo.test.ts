import pngjs from "pngjs";
import { describe, expect, it, vi } from "vitest";

import { decodeImage } from "./app-logo.ts";

const RED = [225, 1, 37, 255];

describe("decodeImage", () => {
  it("returns null for SVG and anything else it can't read", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(decodeImage(svg)).toBeNull();
    expect(decodeImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBeNull();
  });

  it("reads a small PNG, and refuses a huge one from its header before decoding it", () => {
    const small = new pngjs.PNG({ width: 2, height: 2 });
    small.data.set([...RED, ...RED, ...RED, ...RED]);
    const bytes = pngjs.PNG.sync.write(small);
    expect(decodeImage(bytes)?.width).toBe(2);

    const huge = Buffer.from(bytes);
    huge.writeUInt32BE(40_000, 16);
    huge.writeUInt32BE(40_000, 20);
    const read = vi.spyOn(pngjs.PNG.sync, "read");
    expect(decodeImage(huge)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
