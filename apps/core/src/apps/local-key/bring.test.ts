import { describe, expect, it } from "vitest";

import { PrivateFieldRefused } from "../../private-fields.ts";
import { splitKeys } from "@auni/shared";

import { broughtKeys, notes, preview, solanaAlone } from "./bring.ts";

// Known vectors: web3's documented account, and RFC 8032's first Ed25519 key (its seed, then
// its public key, in base58, as Privy exports a Solana key).
const EVM_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const EVM_ADDRESS = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
const SOLANA_KEY =
  "49W385L4rePHy6PAaQUovbD2aacgN4HsKXSMeUzRg4fmwXszN91JuMFrQRj3vMDpZuRF3ZknQBuRBoWQJEfXstMw";
const SOLANA_ADDRESS = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";

describe("splitKeys", () => {
  it("reads either key alone", () => {
    expect(splitKeys(` ${EVM_KEY} `)).toEqual({ evm: [EVM_KEY], solana: [] });
    expect(splitKeys(EVM_KEY.slice(2))).toEqual({ evm: [EVM_KEY.slice(2)], solana: [] });
    expect(splitKeys(SOLANA_KEY)).toEqual({ evm: [], solana: [SOLANA_KEY] });
  });

  it("reads both, on lines of their own or run together by a one-line field", () => {
    const both = { evm: [EVM_KEY], solana: [SOLANA_KEY] };
    expect(splitKeys(`${EVM_KEY}\n${SOLANA_KEY}`)).toEqual(both);
    expect(splitKeys(`"${SOLANA_KEY}", "${EVM_KEY}"`)).toEqual(both);
    expect(splitKeys(`${EVM_KEY}${SOLANA_KEY}`)).toEqual(both);
    expect(splitKeys(`${SOLANA_KEY}${EVM_KEY}`)).toEqual(both);
  });

  it("keeps a short 0x as an EVM key and anything else as a Solana one, for core to refuse", () => {
    expect(splitKeys("0x1234 hello")).toEqual({ evm: ["0x1234"], solana: ["hello"] });
    expect(splitKeys("")).toEqual({ evm: [], solana: [] });
  });
});

describe("broughtKeys", () => {
  it("reads both keys pasted as one, with or without the EVM key's 0x, and the addresses they sign for", async () => {
    expect(await broughtKeys({ keys: ` ${EVM_KEY.slice(2)}\n${SOLANA_KEY} ` })).toEqual({
      keys: { evm: EVM_KEY, solana: SOLANA_KEY },
      addresses: { evm: EVM_ADDRESS, solana: SOLANA_ADDRESS },
    });
    expect(preview({ evm: EVM_ADDRESS, solana: SOLANA_ADDRESS })).toBe(
      `${EVM_ADDRESS} and ${SOLANA_ADDRESS} on Solana`,
    );
    expect(preview({ evm: EVM_ADDRESS, solana: null })).toBe(EVM_ADDRESS);
  });

  it("takes one key alone, or the Solana key in its own input beside the EVM one", async () => {
    expect((await broughtKeys({ keys: "", solana: SOLANA_KEY })).keys).toEqual({
      evm: null,
      solana: SOLANA_KEY,
    });
    expect((await broughtKeys({ keys: EVM_KEY })).keys).toEqual({ evm: EVM_KEY, solana: null });
    expect((await broughtKeys({ keys: EVM_KEY, solana: SOLANA_KEY })).keys).toEqual({
      evm: EVM_KEY,
      solana: SOLANA_KEY,
    });
  });

  it("refuses two keys of a kind, and an EVM key where only a Solana one belongs", async () => {
    const twice = await broughtKeys({ keys: `${SOLANA_KEY} ${SOLANA_KEY}` }).catch(
      (e: unknown) => e,
    );
    expect(twice).toBeInstanceOf(PrivateFieldRefused);
    const evm = await solanaAlone({ solana: EVM_KEY }).catch((e: unknown) => e);
    expect(evm).toEqual(new PrivateFieldRefused("That isn't a Solana key."));
    expect((await solanaAlone({ solana: SOLANA_KEY })).keys.solana).toBe(SOLANA_KEY);
  });

  it("refuses what isn't a key, in words that never repeat it", async () => {
    for (const values of [
      {} as Record<string, string>,
      { keys: " ", solana: "" },
      { keys: "0x1234" },
      { solana: `${SOLANA_KEY.slice(0, -2)}11` },
      { solana: "not base58 0OIl" },
    ]) {
      const thrown = await broughtKeys(values).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(PrivateFieldRefused);
      expect(String(thrown)).not.toMatch(/1234|49W385|0OIl/u);
    }
  });

  it("names the key at fault: an EVM key no account has is refused as that", async () => {
    // 64 hex characters, but zero, or past the curve's order, is no private key.
    for (const evm of [`0x${"0".repeat(64)}`, `0x${"f".repeat(64)}`]) {
      const thrown = await broughtKeys({ keys: evm, solana: "" }).catch((error: unknown) => error);
      expect(thrown).toEqual(
        new PrivateFieldRefused(
          "That isn't a key any wallet could use. Copy it again from auni.io.",
        ),
      );
      const both = await broughtKeys({ keys: evm, solana: SOLANA_KEY }).catch(
        (error: unknown) => error,
      );
      expect(String(both)).toContain(
        "That isn't a key any wallet could use. Copy it again from auni.io.",
      );
    }
    const thrown = await broughtKeys({ keys: EVM_KEY, solana: "notbase58OIl" }).catch(
      (error: unknown) => error,
    );
    expect(String(thrown)).toContain("whole Solana key");
  });
});

describe("notes", () => {
  it("says where the account runs another wallet's code, and that the keys may not be theirs alone", async () => {
    const said = await notes({ evm: EVM_ADDRESS, solana: null }, async () => ["Monad", "Base"]);
    expect(said).toEqual([
      "On Monad, Base this account runs another wallet's code (EIP-7702): your first all-or-nothing move there switches it to MetaMask's DeleGator.",
      "auni.io can still use these keys too.",
    ]);
    expect(await notes({ evm: null, solana: SOLANA_ADDRESS })).toEqual([
      "auni.io can still use these keys too.",
    ]);
  });
});
