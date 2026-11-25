import { describe, expect, it } from "vitest";

import { askAboutKeys, farewell, REMOVE_KEYS, type KeysFacts } from "./uninstall.ts";

const inKeychain = {
  place: 'in the OS keychain, as "wallet-keys:/home/me/.auni" under "auni"',
  inDataFolder: false,
};
const facts: KeysFacts = {
  kept: inKeychain,
  addresses: { evm: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23", solana: null },
  backupSavedAt: new Date("2026-11-02T09:30:00Z"),
  reading: { usd: "12.4", takenAt: new Date("2026-11-14T08:00:00Z") },
};

/** Asks `facts` with these answers typed in turn, and what was said and asked. */
async function asked(answers: readonly string[] | null, given: KeysFacts = facts) {
  const said: string[] = [];
  const questions: string[] = [];
  const queue = [...(answers ?? [])];
  const answer = await askAboutKeys(
    given,
    answers &&
      (async (question) => {
        questions.push(question);
        return queue.shift()!;
      }),
    (line) => said.push(line),
  );
  return { answer, said: said.join("\n"), questions };
}

describe("uninstalling, the wallet's keys", () => {
  it("stay when the owner presses Enter, after being told where they are and what they hold", async () => {
    const { answer, said, questions } = await asked([""]);
    expect(answer).toBe("keep");
    expect(said).toContain(`Your wallet keys are ${inKeychain.place}.`);
    expect(said).toContain(
      "They sign for 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23 (Ethereum, Base, Monad, and other networks).",
    );
    expect(said).toContain("Last recorded balance (2026-11-14 08:00 UTC): $12.40.");
    expect(said).toContain("your backup from 2026-11-02 09:30 UTC");
    expect(questions).toEqual([
      `Press Enter to keep them, or type "${REMOVE_KEYS}" to remove them: `,
    ]);
  });

  it("are removed only on the sentence that says what removing does", async () => {
    expect((await asked([REMOVE_KEYS])).answer).toBe("remove");
    expect((await asked([`  ${REMOVE_KEYS}\n`])).answer).toBe("remove");
  });

  // A mistyped sentence may still have meant yes, so it is asked again, not taken as a no.
  it("stop the uninstall with nothing removed on any other answer", async () => {
    for (const typed of ["yes", "y", "remove", "Remove my keys and lose this wallet"]) {
      const { answer, said } = await asked([typed]);
      expect(answer).toBe("stop");
      expect(said).toMatch(/nothing was removed/u);
    }
  });

  it("stay, unasked, with no terminal to ask in", async () => {
    const { answer, said } = await asked(null);
    expect(answer).toBe("keep");
    expect(said).toContain(inKeychain.place);
  });

  it("stay, unasked, before the owner has saved the wallet's backup", async () => {
    const { answer, said, questions } = await asked([REMOVE_KEYS], {
      ...facts,
      backupSavedAt: null,
    });
    expect(answer).toBe("keep");
    expect(questions).toEqual([]);
    expect(said).toMatch(/haven't saved a backup of this wallet yet/u);
  });

  it("are said truthfully as Auni goes: a keychain entry outlives the data folder", () => {
    expect(farewell("/home/me/.auni", inKeychain, false)).toBe(
      "Auni is uninstalled.\nYour database and settings stay in /home/me/.auni.\n" +
        `Your wallet keys stay ${inKeychain.place}.\n` +
        "If you reinstall with the same data folder, Auni can use this wallet again.",
    );
    expect(
      farewell("/srv/auni", { place: "in /srv/auni/wallet-keys.json", inDataFolder: true }, false),
    ).toMatch(/stay in \/srv\/auni\.\nYour wallet keys are in that folder/u);
    expect(farewell("/home/me/.auni", inKeychain, true)).toMatch(/Your wallet keys were removed/u);
    expect(farewell("/home/me/.auni", null, false)).not.toMatch(/keys/u);
  });
});
