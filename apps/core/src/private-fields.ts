import type { PrivateCheckWire, PrivateFieldWire } from "@auni/shared";

// A secret the owner types goes in only through a private field. Core declares it, the browser
// draws it (the web's PrivateInput, or a card the agent asked for with request_secret), and the
// value goes to core's own route (routes/private.ts) and nowhere else: never to a thread, the
// agent, a log, an error, a response, the URL, browser storage or a cache. Wallet keys come in
// this way, and so does each app's secret settings (settings.ts) and a brain's sign-in code.

export type PrivateValues = Readonly<Record<string, string>>;

export interface PrivateField extends PrivateFieldWire {
  /**
   * True for system settings the owner edits only from Settings (such as custom RPC URLs or the
   * Alchemy key), which the agent's `request_secret` tool never offers a card for.
   */
  readonly ownerOnly?: boolean;
  /** What the values would do, said without them, such as the addresses keys sign for. */
  check(values: PrivateValues): Promise<PrivateCheckWire>;
  /**
   * Takes the values in for good, and says anything the owner should know of how they were
   * taken (a key saved without its service trying it); null when there is nothing to say.
   */
  accept(values: PrivateValues): Promise<string | null>;
  /** Forgets the value held for one of its inputs, on a field whose values can be taken back. */
  clear?(input: string): Promise<void>;
}

/**
 * Values a field turns down. Its message is fixed text the owner reads, and never quotes what
 * was typed.
 */
export class PrivateFieldRefused extends Error {}

/**
 * Every field core takes now: the wallet's (keys to bring while there is no wallet, a Solana key
 * beside an EVM key alone), each app's secret settings, and the line a brain's own sign-in waits
 * on. Each is loaded when asked for, since each of those files imports this one.
 */
export async function privateFields(): Promise<PrivateField[]> {
  const [{ walletFields }, { networkFields, settingFields }, { signInFields }] = await Promise.all([
    import("./money/wallets.ts"),
    import("./settings.ts"),
    import("./agent/sign-in.ts"),
  ]);
  return [
    ...(await walletFields()),
    ...(await settingFields()),
    ...networkFields(),
    ...signInFields(),
  ];
}

/** The field core takes now by this id, or null. */
export async function privateField(id: string): Promise<PrivateField | null> {
  return (await privateFields()).find((field) => field.id === id) ?? null;
}

/** A field as the browser draws it: what it says, never what it does. */
export function fieldWire({
  id,
  label,
  goes,
  app,
  inputs,
  link,
  confirms,
  proof,
}: PrivateField): PrivateFieldWire {
  return { id, label, goes, app, inputs, link, confirms, proof };
}

/** Where a secret the owner pastes goes, as the one line under its field says it. */
export const GOES_TO_SETTINGS =
  "It goes straight to Auni's settings file on this computer. Auni's AI never sees it.";
