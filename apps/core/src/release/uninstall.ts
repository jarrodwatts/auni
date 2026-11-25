import { readlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { desc } from "drizzle-orm";

import type { KeptKeys, WalletAddresses } from "../apps/contract.ts";
import { theWallet } from "../apps/registry.ts";
import { dataDir, toolsDir } from "../data-dir.ts";
import { db } from "../db/client.ts";
import { valueSnapshots } from "../db/schema.ts";
import { serviceInstalled, uninstallService } from "../service.ts";
import { ownerState, walletFacts } from "../setup.ts";
import { appDir, launcher } from "./layout.ts";

/** What the owner types to remove their wallet's keys: it says what that does. */
export const REMOVE_KEYS = "remove my keys and lose this wallet";

/** What the owner is told before being asked whether to remove their wallet's keys. */
export interface KeysFacts {
  readonly kept: KeptKeys;
  readonly addresses: WalletAddresses | null;
  /** When they said they saved the wallet's backup, in first run. */
  readonly backupSavedAt: Date | null;
  /** Auni's last reading of everything they hold. */
  readonly reading: { readonly usd: string; readonly takenAt: Date } | null;
}

/** Whether `auni uninstall` removes the wallet's keys too, or stops with nothing removed. */
export type KeysChoice = { readonly kept: KeptKeys | null; readonly remove: boolean } | "stop";

/** Asks the owner a question in the terminal; null where there is no terminal to ask in. */
export type Ask = ((question: string) => Promise<string>) | null;

const when = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Says where the wallet's keys are and asks whether to remove them. Keeping them is what Enter
 * does, and all that happens without a terminal or before the owner saved the wallet's backup:
 * only the sentence that says what removing does removes them. Any other answer stops the
 * uninstall with nothing removed, since a mistyped sentence may still have meant yes.
 */
export async function askAboutKeys(
  { kept, addresses, backupSavedAt, reading }: KeysFacts,
  ask: Ask,
  say: (line: string) => void,
): Promise<"keep" | "remove" | "stop"> {
  say(`Your wallet keys are ${kept.place}.`);
  if (addresses) {
    const signed = [
      addresses.evm && `${addresses.evm} (Ethereum, Base, Monad, and other networks)`,
      addresses.solana && `${addresses.solana} (Solana)`,
    ];
    say(`They sign for ${signed.filter(Boolean).join(" and ")}.`);
  }
  if (!ask) return "keep";
  if (!backupSavedAt) {
    say("You haven't saved a backup of this wallet yet, so its keys will stay on this computer.");
    return "keep";
  }
  say(
    reading
      ? `Last recorded balance (${when(reading.takenAt)}): $${Number(reading.usd).toFixed(2)}.`
      : "Auni has no recorded balance for this wallet.",
  );
  say(
    "Removing these keys permanently deletes access to this wallet and any funds or connected " +
      `accounts it controls, unless you have your backup from ${when(backupSavedAt)}. ` +
      "If you're unsure, keep them: they stay idle while Auni is uninstalled, and reinstalling " +
      "Auni will pick them up again.",
  );
  const answer = (
    await ask(`Press Enter to keep them, or type "${REMOVE_KEYS}" to remove them: `)
  ).trim();
  if (answer === "") return "keep";
  if (answer === REMOVE_KEYS) return "remove";
  say("Confirmation didn't match, so nothing was removed. Run auni uninstall to try again.");
  return "stop";
}

/** Asks whether to remove the wallet's keys, reading what the owner is told from the database. */
export async function keysChoice(ask: Ask): Promise<KeysChoice> {
  const kept = (await theWallet().keptHere?.where()) ?? null;
  if (!kept) return { kept, remove: false };
  const [{ addresses }, { backupSavedAt }, [reading]] = await Promise.all([
    walletFacts(),
    ownerState(),
    db
      .select({ usd: valueSnapshots.usdValue, takenAt: valueSnapshots.takenAt })
      .from(valueSnapshots)
      .orderBy(desc(valueSnapshots.takenAt))
      .limit(1),
  ]);
  const answer = await askAboutKeys(
    { kept, addresses, backupSavedAt, reading: reading ?? null },
    ask,
    console.log,
  );
  return answer === "stop" ? answer : { kept, remove: answer === "remove" };
}

/**
 * `auni uninstall`: removes the service, the wallet's keys when the owner chose to (keysChoice),
 * the `auni` command, every version of Auni's app and the CLIs it installed. What else Auni keeps of the owner's stays
 * in the data folder: the database and their settings.
 */
export async function uninstall({ kept, remove }: Exclude<KeysChoice, "stop">): Promise<void> {
  if (serviceInstalled()) uninstallService();
  // Before the app goes, so a keychain that refuses leaves Auni there to try again with.
  if (remove) await theWallet().keptHere!.remove();
  // ~/.local/bin/auni, when it's still install.sh's link to the launcher.
  const command = join(homedir(), ".local/bin/auni");
  const link = (() => {
    try {
      return readlinkSync(command);
    } catch {
      return null;
    }
  })();
  if (link === launcher()) rmSync(command);
  rmSync(appDir(), { recursive: true, force: true });
  // A CLI Auni installed for the owner (Codex); the login it signed in to stays in its own home.
  rmSync(toolsDir(), { recursive: true, force: true });
  console.log(farewell(dataDir(), kept, remove));
}

/** What `auni uninstall` says it left, and where. */
export function farewell(dir: string, kept: KeptKeys | null, removed: boolean): string {
  const data = `Your database and settings stay in ${dir}.`;
  const lines = ["Auni is uninstalled.", data];
  if (removed) lines.push("Your wallet keys were removed.");
  else if (kept?.inDataFolder) {
    lines.push(
      "Your wallet keys are in that folder.",
      "Move your funds or save a backup before deleting it.",
    );
  } else if (kept) {
    lines.push(
      `Your wallet keys stay ${kept.place}.`,
      "If you reinstall with the same data folder, Auni can use this wallet again.",
    );
  }
  return lines.join("\n");
}
