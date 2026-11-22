import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

import {
  NETWORK_KEYS,
  NETWORKS,
  type AppAbout,
  type AppSetting,
  type NetworkKey,
} from "@auni/shared";

import { dataDir, envFile } from "./data-dir.ts";
import {
  GOES_TO_SETTINGS,
  PrivateFieldRefused,
  type PrivateField,
  type PrivateValues,
} from "./private-fields.ts";

// The owner's settings: the variables in their settings file (`.env` in the data folder), under
// whatever this computer's environment already sets. An app declares the ones it reads in its
// meta (`settings`) and reads each where it is used, with `setting`, so a value saved from the web
// app works with no restart. The apps the owner turned off are one more line of the same file
// (`APPS_OFF`). This file reads the environment itself and never env.ts, which parses it once:
// `auni` loads the settings file here before env.ts may be imported (boot.ts).

/** The names this computer's environment set itself, before the settings file was read. */
let fromEnvironment: ReadonlySet<string> | undefined;

function fileText(): string {
  try {
    return readFileSync(envFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** The name of every setting in the owner's settings file, whatever its value. */
export function fileSettingNames(): string[] {
  return Object.keys(parseEnv(fileText()));
}

/**
 * Loads the owner's settings file into the environment, under what the environment already sets.
 * An empty value means unset wherever it is, as it does to env.ts, so an empty variable in the
 * environment never hides the file's.
 */
export function readSettings(): void {
  fromEnvironment ??= new Set(Object.keys(process.env).filter((name) => process.env[name]));
  for (const [name, value] of Object.entries(parseEnv(fileText())))
    if (!process.env[name]) process.env[name] = value;
}

/** One of an app's own settings as it is now (see AppAbout.settings); undefined while unset. */
export function setting<Key extends string>(
  about: { readonly settings: Readonly<Record<Key, AppSetting>> },
  key: Key,
): string | undefined {
  return process.env[about.settings[key].env] || undefined;
}

/**
 * One of an app's settings it can't work without, or an error saying in the owner's words that it
 * is missing and where it goes. Never the variable's name: the agent reads the error and would
 * repeat it to the owner.
 */
export function requiredSetting<Key extends string>(
  about: { readonly name: string; readonly settings: Readonly<Record<Key, AppSetting>> },
  key: Key,
): string {
  const value = setting(about, key);
  if (value) return value;
  const { label, kind } = about.settings[key];
  const where =
    kind === "secret"
      ? "which goes in on its page under Apps"
      : "which goes in Auni's settings file";
  throw new Error(`${about.name} isn't set up yet: it needs its ${label}, ${where}.`);
}

/**
 * Where a setting's value comes from now: this computer's environment, which the app shows as
 * "Set by this computer" and never changes; the owner's settings file; or null while it is unset.
 */
export function setBy(name: string): "environment" | "file" | null {
  if (!process.env[name]) return null;
  return fromEnvironment?.has(name) ? "environment" : "file";
}

/** The line of the settings file that lists the apps the owner turned off, by id. */
const APPS_OFF = "APPS_OFF";

/** The ids of the apps the owner turned off (see `offered` in apps/registry.ts). */
export function appsOff(): ReadonlySet<string> {
  return new Set(
    (process.env[APPS_OFF] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

let changed = new AbortController();

/**
 * Aborts the next time a setting is saved. A loop that reads its settings once as it starts (a
 * channel listening, a watch source running) ends on it and starts again with the new ones.
 */
export function settingsChanged(): AbortSignal {
  return changed.signal;
}

/** Calls `heard` each time a setting is saved, with its variable name, until unsubscribed. */
export function onSettingsChange(heard: (name: string) => void): () => void {
  let listening = true;
  const next = () =>
    settingsChanged().addEventListener(
      "abort",
      (event) => {
        if (!listening) return;
        const reason = (event.target as AbortSignal | null)?.reason;
        heard(typeof reason === "string" ? reason : "");
        next();
      },
      { once: true },
    );
  next();
  return () => {
    listening = false;
  };
}

/**
 * The variable an app's secret is kept in must start with the app's id ("ELFA_" for elfa),
 * so no app can make one of core's own settings, or another app's, writable from a browser.
 */
export function ownedBy(about: Pick<AppAbout, "id">, name: string): boolean {
  return name.startsWith(`${about.id.toUpperCase().replaceAll("-", "_")}_`);
}

/** Whether `name` is a secret some app declares as its own: the only names a save may write. */
async function writable(name: string): Promise<boolean> {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) return false;
  // Loaded when called, since apps import this file and the registry imports every app.
  const { apps } = await import("./apps/registry.ts");
  return apps().some(
    ({ about }) =>
      ownedBy(about, name) &&
      Object.values(about.settings ?? {}).some(
        (declared) => declared.env === name && declared.kind === "secret",
      ),
  );
}

/** What a saved value may hold: printable ASCII but the single quote it is written inside. */
const SAVABLE = /^[\x20-\x26\x28-\x7e]*$/u;

const UNSAFE =
  "Auni couldn't change its settings file safely. Set this by hand in the .env file in Auni's folder, then start Auni again.";

/**
 * Saves a secret an app declared to the owner's settings file, and puts it in use at once.
 * Throws a PrivateFieldRefused, in fixed words that never quote the value, for a value or a file
 * the writer turns down (see write).
 */
export async function saveSetting(name: string, typed: string): Promise<void> {
  if (!(await writable(name))) throw new Error(`${name} is not a setting Auni saves.`);
  write(name, savable(typed));
}

/**
 * Forgets a secret an app declared, in the owner's settings file and at once: its app works as
 * if it was never given.
 */
export async function clearSetting(name: string): Promise<void> {
  if (!(await writable(name))) throw new Error(`${name} is not a setting Auni saves.`);
  write(name, "");
}

/**
 * Turns an app on or off for the owner, in their settings file, and in use at once: the
 * registry's `offered` reads it on every call. Only an app with a switch is taken (see
 * hasSwitch): one core's own work runs on can never be turned off from the app.
 */
export async function saveSwitch(id: string, on: boolean): Promise<void> {
  // Loaded when called, since apps import this file and the registry imports every app.
  const { hasSwitch, apps } = await import("./apps/registry.ts");
  const switched = new Set(apps().flatMap((app) => (hasSwitch(app) ? [app.about.id] : [])));
  if (!switched.has(id)) throw new Error(`${id} is not an app the owner can turn on or off.`);
  const off = new Set([...appsOff()].filter((each) => switched.has(each)));
  if (on) off.delete(id);
  else off.add(id);
  write(APPS_OFF, [...off].toSorted().join(","));
}

/**
 * Records that Auni runs always on (always-on.ts): the owner's Tailscale login and this machine's
 * https address on the tailnet. Both keys are validated and saved atomically in one file write.
 */
export function saveAlwaysOn(owner: string, origin: string): void {
  writeMany([
    ["WEB_ORIGIN", origin],
    ["TAILSCALE_OWNER", owner],
  ]);
}

/**
 * Clears Tailscale always-on settings atomically so Auni returns to local-only pairing mode on
 * next start. If either variable is locked by the host environment, neither is changed.
 */
export function clearAlwaysOn(): void {
  writeMany([
    ["TAILSCALE_OWNER", ""],
    ["WEB_ORIGIN", ""],
  ]);
}

/**
 * Sets or clears the owner's preferred brain app (`BRAIN`) in the settings file and immediately
 * in this process. Validates that any non-null id names a real brain app.
 */
export async function savePreferredBrain(id: string | null): Promise<void> {
  if (id !== null) {
    const { brains } = await import("./apps/registry.ts");
    if (!brains().some(({ about }) => about.id === id))
      throw new PrivateFieldRefused(`${id} is not an AI brain in this Auni.`);
  }
  write("BRAIN", id ?? "");
}

/** Whether a custom RPC URL is safe to store and use: HTTPS, or local loopback HTTP for a fork/node. */
function validRpcUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!SAVABLE.test(trimmed))
    throw new PrivateFieldRefused("That URL contains characters that cannot be saved safely.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PrivateFieldRefused("Enter a valid RPC URL.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    throw new PrivateFieldRefused("RPC URLs must use HTTPS (or localhost HTTP for a local node).");
  // Preserve the owner's exact path/query without stripping trailing slashes required by some RPCs.
  return trimmed;
}

/**
 * Sets or clears a custom RPC URL (`RPC_URL_<CHAIN>`) in the owner's settings file and puts it
 * in use immediately (money/chains.ts clears cached clients on settings change).
 */
export function saveRpcUrl(chain: NetworkKey, url: string | null): void {
  if (!(NETWORK_KEYS as readonly string[]).includes(chain))
    throw new PrivateFieldRefused(`${chain} is not a supported network.`);
  const envName = `RPC_URL_${chain.toUpperCase()}`;
  write(envName, url === null || url.trim() === "" ? "" : validRpcUrl(url));
}

/**
 * Sets or clears `ALCHEMY_API_KEY` in the owner's settings file and puts it in use immediately.
 * Never returns or logs the key value.
 */
export function saveAlchemyKey(key: string | null): void {
  write("ALCHEMY_API_KEY", key === null || key.trim() === "" ? "" : savable(key));
}

/**
 * The one writer of the owner's settings file, which puts what it wrote in use at once.
 *
 * A browser session reaches it, and the same file holds settings that change whom Auni trusts
 * (a chain's RPC, which wallet signs, the Tailscale owner), which a session must never reach. So
 * it is strict:
 * 1. Its callers from a session hand it only a name an app declares as its own secret (see
 *    writable), or the list of apps turned off, made of the ids of apps that have a switch;
 *    saveAlwaysOn is the terminal's alone.
 * 2. The value is printable ASCII with no single quote, written inside single quotes, where the
 *    parser reads every character as itself. A line break or a quote could start a second setting.
 * 3. The new text is parsed with the parser that will load it, and is kept only if what it sets
 *    differs from the old file by this one name.
 * 4. It is written beside the file, readable by the owner alone, and renamed over it, so every
 *    other line stays as it was and the file is never half written.
 *
 * Nothing in it waits, so two saves never read the same old file.
 */
function write(name: string, value: string): void {
  writeMany([[name, value]]);
}

function writeMany(entries: readonly (readonly [name: string, value: string])[]): void {
  if (entries.length === 0) return;
  for (const [name, value] of entries) {
    if (fromEnvironment?.has(name))
      throw new PrivateFieldRefused(
        `This computer's environment sets ${name} itself, so Auni can't change it here.`,
      );
    if (!SAVABLE.test(value)) throw new PrivateFieldRefused(UNSAFE);
  }

  const old = fileText();
  let next = old;
  for (const [name, value] of entries) {
    const line = `${name}='${value}'`;
    const assigns = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "u");
    let placed = false;
    const kept = next.split("\n").flatMap((each) => {
      if (!assigns.test(each)) return [each];
      if (placed) return [];
      placed = true;
      return [line];
    });
    next = placed ? kept.join("\n") : `${next}${next && !next.endsWith("\n") ? "\n" : ""}${line}\n`;
  }

  const targets = new Map(entries);
  const [was, now] = [parseEnv(old), parseEnv(next)];
  const differs = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
    (each) => was[each] !== now[each],
  );
  for (const [name, value] of targets) {
    if (now[name] !== value) throw new PrivateFieldRefused(UNSAFE);
  }
  if (differs.some((each) => !targets.has(each))) throw new PrivateFieldRefused(UNSAFE);

  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const beside = `${envFile()}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(beside, next, { mode: 0o600, flag: "wx" });
    renameSync(beside, envFile());
  } catch (error) {
    rmSync(beside, { force: true });
    throw error;
  }
  for (const [name, value] of entries) {
    process.env[name] = value;
  }
  for (const [name] of entries) {
    const ended = changed;
    changed = new AbortController();
    ended.abort(name);
  }
}

/** A typed value as it is saved, or a refusal: keys are pasted, so the space around one goes. */
function savable(typed: string): string {
  const value = typed.trim();
  if (!value) throw new PrivateFieldRefused("Paste the key first.");
  if (!SAVABLE.test(value))
    throw new PrivateFieldRefused(
      "That doesn't look like a key: it holds a quote mark, a line break or a hidden character. Copy it again and paste only the key.",
    );
  return value;
}

/**
 * The secrets saved while their service couldn't be asked about them, by variable name: the app
 * says so beside each until it is saved again, or Auni restarts.
 */
const untried = new Set<string>();

/** Whether this secret was saved without its service trying it (see untried). */
export const savedUntried = (name: string): boolean => untried.has(name);

/** The private field an app's secret settings are typed into, by the app's id. */
export const settingField = (app: string) => `keys:${app}`;

/** An app's link for where to get a key, when it is a page Auni would open: https alone. */
const linkOf = (link: string | undefined): string | null =>
  link && URL.canParse(link) && new URL(link).protocol === "https:" ? link : null;

/**
 * Every app's secret settings, as one private field for each app (private-fields.ts) with an
 * input for each secret of its own that this computer's environment doesn't set. A key is tried
 * with its service first (App.tryKey): if the service refuses any key typed, none is saved, and
 * one it couldn't be asked about is saved, saying so. An input may be left empty, so one key is
 * replaced alone.
 */
export async function settingFields(): Promise<PrivateField[]> {
  const { apps } = await import("./apps/registry.ts");
  return apps().flatMap(({ about, tryKey }) => {
    // Only a secret under its own app's name: no app can declare one of core's (see ownedBy).
    const secrets = Object.entries(about.settings ?? {}).filter(
      ([, declared]) =>
        declared.kind === "secret" &&
        ownedBy(about, declared.env) &&
        setBy(declared.env) !== "environment",
    );
    const [only] = secrets;
    if (!only) return [];
    const declaredAs = (key: string) => secrets.find(([each]) => each === key)?.[1];
    return [
      {
        id: settingField(about.id),
        label: secrets.length === 1 ? only[1].label : `${about.name} keys`,
        goes: GOES_TO_SETTINGS,
        app: about.id,
        inputs: secrets.map(([key, declared]) => ({
          name: key,
          label: declared.label,
          placeholder: "Paste it here",
          set: setBy(declared.env) !== null,
        })),
        link: secrets.map(([, declared]) => linkOf(declared.link)).find(Boolean) ?? null,
        confirms: false,
        proof: false,
        async check(values) {
          typedKeys(values);
          return { preview: "", notes: [] };
        },
        async accept(values) {
          const typed = typedKeys(values);
          const tried = await Promise.all(
            typed.map(async ([key, value]) => (tryKey ? await tryKey(key, value) : null)),
          );
          const refused = typed.find((_, index) => tried[index] === "refused");
          if (refused)
            throw new PrivateFieldRefused(
              `${about.name} refused ${typed.length === 1 ? "that key" : `the ${declaredAs(refused[0])!.label}`}, so nothing was saved. Check you copied all of it, and paste it again.`,
            );
          for (const [index, [key, value]] of typed.entries()) {
            const { env } = declaredAs(key)!;
            await saveSetting(env, value);
            if (tried[index] === "unreachable") untried.add(env);
            else untried.delete(env);
          }
          // Null: tried once the rest it is tried with come in.
          return tried.includes("unreachable")
            ? `Saved, but ${about.name} couldn't be reached to try it. Auni uses it from now on, and says so if ${about.name} turns it down.`
            : null;
        },
        async clear(input) {
          const declared = declaredAs(input);
          if (!declared) throw new PrivateFieldRefused("That isn't one of this app's keys.");
          await clearSetting(declared.env);
          untried.delete(declared.env);
        },
      } satisfies PrivateField,
    ];
  });
}

/** Private field ids for core's step-up-gated network credentials (Alchemy key & per-chain RPCs). */
export const ALCHEMY_FIELD = "system:alchemy";
export const rpcField = (chain: NetworkKey) => `system:rpc:${chain}`;

/**
 * Core's private fields for RPC credentials: Alchemy API key and per-chain custom RPC URLs.
 * Every one requires owner step-up proof (`proof: true`) and never echoes or caches values.
 */
export function networkFields(): PrivateField[] {
  const fields: PrivateField[] = [];
  if (setBy("ALCHEMY_API_KEY") !== "environment") {
    fields.push({
      id: ALCHEMY_FIELD,
      label: "Alchemy API key",
      goes: GOES_TO_SETTINGS,
      app: "auni",
      ownerOnly: true,
      inputs: [
        {
          name: "apiKey",
          label: "Alchemy API key",
          placeholder: "Paste Alchemy API key",
          set: setBy("ALCHEMY_API_KEY") !== null,
        },
      ],
      link: null,
      confirms: false,
      proof: true,
      async check(values) {
        savable(values.apiKey ?? "");
        return { preview: "", notes: [] };
      },
      async accept(values) {
        saveAlchemyKey(values.apiKey ?? "");
        return null;
      },
      async clear(input) {
        if (input !== "apiKey") throw new PrivateFieldRefused("Unknown input.");
        saveAlchemyKey(null);
      },
    });
  }
  for (const chain of NETWORK_KEYS) {
    const envVar = `RPC_URL_${chain.toUpperCase()}`;
    if (setBy(envVar) === "environment") continue;
    fields.push({
      id: rpcField(chain),
      label: `${NETWORKS[chain].name} RPC URL`,
      goes: GOES_TO_SETTINGS,
      app: "auni",
      ownerOnly: true,
      inputs: [
        {
          name: "url",
          label: `${NETWORKS[chain].name} RPC URL`,
          placeholder: "Paste custom RPC URL",
          set: setBy(envVar) !== null,
        },
      ],
      link: null,
      confirms: false,
      proof: true,
      async check(values) {
        const cleaned = validRpcUrl(values.url ?? "");
        return { preview: new URL(cleaned).host, notes: [] };
      },
      async accept(values) {
        saveRpcUrl(chain, values.url ?? "");
        return null;
      },
      async clear(input) {
        if (input !== "url") throw new PrivateFieldRefused("Unknown input.");
        saveRpcUrl(chain, null);
      },
    });
  }
  return fields;
}

/** Each key typed, as it is saved: one left empty is left as it is, but one must be typed. */
function typedKeys(values: PrivateValues): (readonly [string, string])[] {
  const typed = Object.entries(values).filter(([, value]) => value.trim() !== "");
  if (typed.length === 0) throw new PrivateFieldRefused("Paste the key first.");
  return typed.map(([key, value]) => [key, savable(value)] as const);
}
