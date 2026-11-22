import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { WalletProvider } from "../apps/contract.ts";
import { dataDir, envFile } from "../data-dir.ts";
import { checkExport, databaseUnused, ExportRefused, importDatabase } from "../db/export.ts";
import { unpacked, type Bundle } from "./bundle.ts";
import { takingOver, takingFile, handedOver } from "./marks.ts";
import { keysFor, open, proofText, SealBroken, type HandoverKeys } from "./seal.ts";

// The new machine's half of a handover (hand-over.ts is the laptop's): `auni take-over --from
// <address>`, with the code in AUNI_HANDOVER_CODE, run here after install.sh. In order:
//
//   1. refuse a machine that holds an Auni already, before the code is spent
//   2. fetch the sealed bundle from the laptop, and keep it sealed in taking-over.sealed
//   3. open it and check this Auni can take it in (the database's version, the wallet) and be
//      always on here (`placeHere`: Tailscale, HTTPS, a port), or tell the laptop no, so it
//      carries on at once
//   4. tell the laptop it's opened, and Auni's address here, port and all: the laptop notes
//      it's handed over, sends the owner there, and never runs again
//   5. only then put it all in place: the keys, the settings, the database; then the caller
//      runs always-on setup on that port (always-on.ts)
//
// Until 4 answers, nothing here can run as the owner's Auni: no keys, an empty database, and
// taking-over.sealed, which stops `auni` starting. Cut off after 4, the same command (or with
// --finish, when the laptop can't be reached to ask again) carries on from taking-over.sealed.

/** The takeover can't go on; its message is for the owner, never holding a key or the code. */
export class TakeOverRefused extends Error {}

/** This machine's Auni, as a takeover reads and fills it. */
export interface NewMachine {
  /** The database the takeover loads into, which Auni must never have used. */
  readonly databaseUrl: string;
  /** The wallet app this machine runs, which keeps the keys a handover carries. */
  readonly wallet: { readonly app: string; readonly provided: WalletProvider };
  /**
   * Where Auni will be always on here, as `auni up --always-on --port <port>` will serve it,
   * found without changing anything; throws a TakeOverRefused saying why it can't be.
   */
  readonly alwaysOnAt: () => Promise<AlwaysOnAt>;
}

/** Auni's address here once always on, and the port always-on setup serves it on. */
export interface AlwaysOnAt {
  readonly address: string;
  readonly port: number;
}

/** Where the database's file waits while the takeover puts it in place. */
const exportFile = () => join(dataDir(), "exports", "taking-over.jsonl.gz");

/**
 * Takes Auni over from the laptop at `from` ("100.64.0.1:41234"), with the code it showed:
 * where Auni is to be always on here, which the laptop now sends the owner to.
 */
export async function takeOver(
  { from, code, finish = false }: { from: string; code: string; finish?: boolean },
  here: NewMachine,
  say: (line: string) => void = console.log,
): Promise<AlwaysOnAt> {
  const keys = await keysFor(code).catch(() => {
    throw new TakeOverRefused(
      "AUNI_HANDOVER_CODE isn't the code your laptop showed: copy the whole command from Settings there again.",
    );
  });
  const resuming = takingOver() && (await opensWith(keys));
  if (resuming) say("Carrying on with taking Auni over here, which was cut off.");
  else await holdsNoAuni(here);
  if (finish && !resuming)
    throw new TakeOverRefused(
      "Auni isn't on its way in here, so there's nothing to finish and nothing changed.",
    );

  let sealed: Buffer;
  if (resuming) sealed = await readFile(takingFile());
  else {
    say(`Fetching Auni from your laptop at ${from}. It finishes what it's running first.`);
    sealed = await fetchBundle(from, keys);
    await mkdir(dataDir(), { recursive: true, mode: 0o700 });
    await writeFile(takingFile(), sealed, { mode: 0o600, flag: "wx" });
  }

  let bundle: Bundle;
  try {
    bundle = unpacked(open(keys, sealed));
    await canTakeIn(bundle, here);
  } catch (error) {
    // Nothing changed: the laptop hears so and carries on at once.
    if (!resuming) await told(from, keys, "/handover/declined").catch(() => null);
    await rm(takingFile(), { force: true });
    throw error instanceof TakeOverRefused || error instanceof SealBroken
      ? new TakeOverRefused(`${error.message} Nothing changed: Auni carries on on your laptop.`)
      : error;
  }

  // Where Auni will be here, which the laptop sends the owner to. A machine that can't be always
  // on is refused while the laptop still carries on; resumed, when the laptop may have let go
  // already, the sealed bundle stays for the next run.
  let at: AlwaysOnAt;
  try {
    at = await here.alwaysOnAt();
  } catch (error) {
    if (!(error instanceof TakeOverRefused)) throw error;
    if (resuming)
      throw new TakeOverRefused(`${error.message} Run this same command again once it can.`);
    await told(from, keys, "/handover/declined").catch(() => null);
    await rm(takingFile(), { force: true });
    throw new TakeOverRefused(`${error.message} Nothing changed: Auni carries on on your laptop.`);
  }

  if (!finish) await laptopLetGo(from, keys, at.address);
  await putInPlace(bundle, here);
  await rm(takingFile(), { force: true });
  say("Everything Auni keeps is here: its database, your routines, your settings and your wallet.");
  return at;
}

/**
 * Whether the bundle a cut-off takeover left here opens with this code. A new code means the
 * laptop made a new handover, which it does only while it still runs, never once it let go: so
 * what was left is stale, and goes.
 */
async function opensWith(keys: HandoverKeys): Promise<boolean> {
  try {
    open(keys, await readFile(takingFile()));
    return true;
  } catch (error) {
    if (!(error instanceof SealBroken)) throw error;
    await rm(takingFile(), { force: true });
    return false;
  }
}

/** Refuses a machine that holds an Auni of its own already: a takeover never writes over one. */
async function holdsNoAuni(here: NewMachine): Promise<void> {
  const holds = (what: string) =>
    new TakeOverRefused(
      `This machine holds an Auni already (${what}), and Auni is never taken over on top of one. Use a new AUNI_HOME, or remove that Auni first (auni uninstall).`,
    );
  if (handedOver()) throw holds("one that was handed over from here");
  if (await here.wallet.provided.keptHere?.where()) throw holds("a wallet's keys");
  if (existsSync(envFile())) throw holds(`its settings, in ${envFile()}`);
  if (!(await databaseUnused(here.databaseUrl))) throw holds("its database");
}

/** Throws a TakeOverRefused when this Auni can't take the bundle in. */
async function canTakeIn(bundle: Bundle, here: NewMachine): Promise<void> {
  if (bundle.wallet) {
    if (bundle.wallet.app !== here.wallet.app || !here.wallet.provided.keptHere)
      throw new TakeOverRefused(
        `Your laptop's wallet is ${bundle.wallet.app}'s, and this machine's Auni runs ${here.wallet.app}'s.`,
      );
  }
  await mkdir(join(dataDir(), "exports"), { recursive: true, mode: 0o700 });
  await writeFile(exportFile(), bundle.export, { mode: 0o600 });
  try {
    await checkExport(exportFile());
  } catch (error) {
    await rm(exportFile(), { force: true });
    if (!(error instanceof ExportRefused)) throw error;
    throw new TakeOverRefused(
      `Your laptop runs Auni v${bundle.version}, newer than this machine's: run auni update here, then start again from Settings on your laptop.`,
    );
  }
}

/** Tells the laptop something, with the code's proof. */
function told(
  from: string,
  keys: HandoverKeys,
  path: string,
  more: { readonly address?: string } = {},
): Promise<Response> {
  return fetch(`http://${from}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proof: proofText(keys), ...more }),
    signal: AbortSignal.timeout(path === "/handover/bundle" ? 5 * 60_000 : 30_000),
  });
}

/** What the laptop says when it doesn't hand Auni over, in the owner's words. */
const REFUSED: Record<string, string> = {
  wrong_code:
    "Your laptop's Auni didn't take that code: copy the whole command from Settings there again.",
  not_that_machine:
    "Your laptop's Auni is waiting for another machine. Pick this one in Settings there for a new command.",
  expired:
    "That code ran out: a code works for 15 minutes. Start again from Settings on your laptop.",
  used: "That code was used already: a code works once. Start again from Settings on your laptop.",
  busy: "Auni on your laptop is still finishing a money move it was sending. Run this again in a minute.",
};

async function fetchBundle(from: string, keys: HandoverKeys): Promise<Buffer> {
  const reach = `Couldn't reach Auni on your laptop at ${from}. Check it's running there, and that both machines are on Tailscale, then run this again.`;
  const response = await told(from, keys, "/handover/bundle").catch(() => {
    throw new TakeOverRefused(reach);
  });
  if (!response.ok) {
    const { error } = (await response.json().catch(() => ({}))) as { error?: string };
    throw new TakeOverRefused(
      REFUSED[error ?? ""] ??
        (response.status === 410
          ? "That handover has ended. Start again from Settings on your laptop."
          : "Your laptop's Auni couldn't pack itself up, so nothing changed. Look at what it printed, then try again."),
    );
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch {
    throw new TakeOverRefused(
      "The transfer from your laptop was cut off, so nothing changed: Auni carries on there. Start again from Settings on your laptop.",
    );
  }
}

/**
 * Tells the laptop the bundle opened and where Auni will be, and waits for it to say it has
 * stopped for good: only then may the keys go in here. Asked again after a lost answer, the
 * laptop answers the same.
 */
async function laptopLetGo(from: string, keys: HandoverKeys, address: string): Promise<void> {
  for (let tries = 1; ; tries++) {
    const response = await told(from, keys, "/handover/opened", { address }).catch(() => null);
    if (response?.ok) return;
    if (response?.status === 400) {
      // An address the laptop won't send the owner to: nothing changed, and it carries on.
      await told(from, keys, "/handover/declined").catch(() => null);
      await rm(takingFile(), { force: true });
      throw new TakeOverRefused(
        `Your laptop's Auni won't send you to ${address}, which isn't this machine's address on your tailnet, so nothing changed and it carries on there.`,
      );
    }
    if (response?.status === 409) {
      await rm(takingFile(), { force: true });
      throw new TakeOverRefused(
        "Your laptop's Auni took itself back (it waits two minutes for this machine), so nothing changed and it carries on there. Start again from Settings on your laptop.",
      );
    }
    if (tries === 6)
      throw new TakeOverRefused(
        `Couldn't hear from your laptop whether its Auni stopped, so nothing is in place here yet. Run this same command again once your laptop is on. If your laptop can't be reached and its Auni page says Auni moved to this machine, run it with --finish at the end.`,
      );
    await sleep(5_000);
  }
}

/** The keys, then the settings, then the database: each skipped where a cut-off run put it already. */
async function putInPlace(bundle: Bundle, here: NewMachine): Promise<void> {
  const kept = here.wallet.provided.keptHere;
  if (bundle.wallet && kept && !(await kept.where())) await kept.keep(bundle.wallet.keys);
  if (!existsSync(envFile()))
    await writeFile(envFile(), bundle.settings, { mode: 0o600, flag: "wx" });
  if (await databaseUnused(here.databaseUrl)) {
    if (!existsSync(exportFile())) await writeFile(exportFile(), bundle.export, { mode: 0o600 });
    await importDatabase(here.databaseUrl, exportFile());
  }
  await rm(exportFile(), { force: true });
}
