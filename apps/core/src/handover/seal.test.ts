import { describe, expect, it } from "vitest";

import { keysFor, newCode, open, proofText, proves, readCode, seal, SealBroken } from "./seal.ts";

describe("a handover's code and seal", () => {
  it("makes codes of 160 random bits, read back however they're pasted", () => {
    const code = newCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/u);
    expect(newCode()).not.toBe(code);
    expect(readCode(` ${code.toLowerCase().replaceAll("-", " ")} `)).toBe(code.replaceAll("-", ""));
    expect(readCode(code.slice(1))).toBeNull();
    expect(readCode(code.replace(/^./u, "I"))).toBeNull();
  });

  it("opens with the code it was sealed with, and with no other", async () => {
    const code = newCode();
    const keys = await keysFor(code);
    const plain = Buffer.from("the whole of Auni");
    const sealed = seal(keys, plain);
    expect(sealed.includes(plain)).toBe(false);
    expect(open(await keysFor(code.toLowerCase()), sealed).toString()).toBe("the whole of Auni");
    await expect(keysFor(newCode()).then((other) => open(other, sealed))).rejects.toThrow(
      SealBroken,
    );
  });

  it("refuses a bundle cut short or changed on the way", async () => {
    const keys = await keysFor(newCode());
    const sealed = seal(keys, Buffer.alloc(10_000, 7));
    expect(() => open(keys, sealed.subarray(0, sealed.length - 1))).toThrow(SealBroken);
    expect(() => open(keys, sealed.subarray(0, 20))).toThrow(SealBroken);
    const changed = Buffer.from(sealed);
    changed[100]! ^= 1;
    expect(() => open(keys, changed)).toThrow(SealBroken);
  });

  it("takes a proof only from the code's holder, and the proof opens nothing", async () => {
    const code = newCode();
    const keys = await keysFor(code);
    expect(proves(proofText(await keysFor(code)), keys)).toBe(true);
    expect(proves(proofText(await keysFor(newCode())), keys)).toBe(false);
    expect(proves("", keys)).toBe(false);
    expect(keys.proof.equals(keys.seal)).toBe(false);
  });
});
