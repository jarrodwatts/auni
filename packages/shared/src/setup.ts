import { z } from "zod";

/** One model a brain CLI offers on this machine, with the reasoning efforts it supports. */
export const brainModelSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  efforts: z.array(z.string().min(1).max(40)),
  defaultEffort: z.string().min(1).max(40).optional(),
  isDefault: z.boolean().optional(),
});
export type BrainModelWire = z.infer<typeof brainModelSchema>;

/** Explicit brain, model and effort chosen for a thread or as the owner's default. */
export const modelSelectionSchema = z.object({
  brain: z.string().min(1).max(64),
  model: z.string().min(1).max(120).optional(),
  effort: z.string().min(1).max(40).optional(),
});
export type ModelSelectionWire = z.infer<typeof modelSelectionSchema>;

/**
 * One brain app on this machine, as the first step of setup and the model picker show it. A
 * ready one says the credential it thinks on (`login`: "your Claude Max subscription"), its
 * available models, and, where its CLI names one, the account it is signed in to (`signedInAs`).
 */
const brainRowWireSchema = z.discriminatedUnion("state", [
  z.object({
    id: z.string(),
    name: z.string(),
    state: z.literal("ready"),
    login: z.string(),
    signedInAs: z.string().optional(),
    models: z.array(brainModelSchema).default([]),
  }),
  /** Ready, but at its usage limit until `until`. */
  z.object({
    id: z.string(),
    name: z.string(),
    state: z.literal("resting"),
    login: z.string(),
    signedInAs: z.string().optional(),
    models: z.array(brainModelSchema).default([]),
    until: z.iso.datetime({ offset: true }),
  }),
  /** Not ready, and the command the owner runs themselves to fix it. */
  z.object({
    id: z.string(),
    name: z.string(),
    state: z.enum(["not-installed", "signed-out", "expired", "broken"]),
    fix: z.string(),
  }),
]);
export type BrainRowWire = z.infer<typeof brainRowWireSchema>;

/**
 * What a CLI's own sign-in shows the owner while it waits for them, on every open device: a page
 * to open on any device with the code to enter there (Codex's device sign-in), or the CLI's own
 * prompt as a terminal shows it (Claude Code's), whose reply the owner types into `field`, a
 * private field, and which goes to that prompt alone.
 */
const signInViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), url: z.string(), code: z.string() }),
  z.object({
    kind: z.literal("terminal"),
    /** What runs there, as the owner would type it: "claude auth login". */
    command: z.string(),
    output: z.string(),
    field: z.string(),
  }),
]);
export type SignInView = z.infer<typeof signInViewSchema>;

/**
 * What Auni is doing to make a brain ready, at the owner's ask: installing its CLI, signing in
 * (`view` is null while the CLI starts), checking the sign-in took, or stopped, in the CLI's own
 * words or Auni's.
 */
const brainTaskWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("installing") }),
  z.object({ kind: z.literal("signing-in"), view: signInViewSchema.nullable() }),
  z.object({ kind: z.literal("checking") }),
  z.object({ kind: z.literal("failed"), said: z.string() }),
]);
export type BrainTaskWire = z.infer<typeof brainTaskWireSchema>;

/**
 * Every brain app as `GET /brains` shows it, with what Auni can do for each from the web app:
 * install its CLI into Auni's own tools folder, or start its own sign-in. `machine` is this
 * computer's name, where every brain runs.
 */
export const brainsWireSchema = z.object({
  rows: z.array(
    z.object({
      row: brainRowWireSchema,
      task: brainTaskWireSchema.nullable(),
      canInstall: z.boolean(),
      canSignIn: z.boolean(),
    }),
  ),
  blocked: z.string().nullable(),
  machine: z.string(),
});
export type BrainsWire = z.infer<typeof brainsWireSchema>;

/**
 * A field core draws for a secret the owner types (wallet keys, an app's key, a sign-in code),
 * whose value goes only to core's own `POST /private/:id`: never to a thread, the agent or the
 * URL. Every word on it is core's.
 */
export const privateFieldWireSchema = z.object({
  id: z.string(),
  /** What it takes: "Elfa API key", "Solana private key". */
  label: z.string(),
  /** Where what is typed goes, the one line under the field. */
  goes: z.string(),
  /** The app it is for, whose mark it wears. */
  app: z.string(),
  /** Each value it takes; `set` for one held already, which a card asks for only to replace it. */
  inputs: z.array(
    z.object({ name: z.string(), label: z.string(), placeholder: z.string(), set: z.boolean() }),
  ),
  /** The page where the owner gets one, opened by the field's Get a key; null for none. */
  link: z.string().nullable(),
  /** What it would do is shown before it is taken: the address a key signs for. */
  confirms: z.boolean(),
  /** Taking it takes proof the owner is there (core's auth/proof.ts), asked before anything is typed. */
  proof: z.boolean(),
});
export type PrivateFieldWire = z.infer<typeof privateFieldWireSchema>;

/**
 * The private field a Solana key the owner already holds is brought in by, beside the wallet's
 * EVM key: once it is in, the backup the owner saved doesn't hold it.
 */
export const SOLANA_BRING_FIELD = "wallet-solana";

/** What a private field's values would do, said without them: the addresses keys sign for. */
export const privateCheckWireSchema = z.object({
  preview: z.string(),
  notes: z.array(z.string()),
});
export type PrivateCheckWire = z.infer<typeof privateCheckWireSchema>;

/**
 * What core says once it took a private field's values: anything the owner should know of how
 * (a key saved without its service trying it), or null.
 */
export const privateAcceptedWireSchema = z.object({ said: z.string().nullable() });

/**
 * The wallet's spare key: not yet (while the wallet holds nothing worth keeping), due, put off
 * for later, or saved somewhere safe.
 */
const spareKeyWireSchema = z.enum(["not-yet", "due", "later", "saved"]);
export type SpareKeyWire = z.infer<typeof spareKeyWireSchema>;

/** Where first run stands, as `GET /setup` and its steps answer: each fact read fresh. */
export const setupWireSchema = z.object({
  brains: z.object({
    rows: z.array(brainRowWireSchema),
    /** Why no brain can think here whatever the owner logs in to (a BRAIN naming none), or null. */
    blocked: z.string().nullable(),
  }),
  wallet: z.object({
    /** The wallet app's name. */
    name: z.string(),
    /** Null until the owner makes or brings a wallet. */
    addresses: z.object({ evm: z.string().nullable(), solana: z.string().nullable() }).nullable(),
    /** The field that brings keys the owner already has, when the wallet app takes them. */
    bring: privateFieldWireSchema.nullable(),
  }),
  /** Where the wallet's spare key stands, which a chat offers once it's due (core's setup.ts). */
  spareKey: spareKeyWireSchema,
  /** First run is done, so the app opens on Auni's chat. */
  welcomed: z.boolean(),
});
export type SetupWire = z.infer<typeof setupWireSchema>;
