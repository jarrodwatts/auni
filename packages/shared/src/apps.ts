import { z } from "zod";

import { dollarsSchema } from "./money.ts";

/** One setting of an app as the app lists it: what it is and where it is set, never its value. */
const appSettingWireSchema = z.object({
  /** The name its app reads it by: "apiKey". */
  key: z.string(),
  label: z.string(),
  /** secret: typed into the app. file: shown, and changed only in the owner's settings file. */
  kind: z.enum(["secret", "file"]),
  /** The app does nothing until it is set. */
  required: z.boolean(),
  help: z.string().nullable(),
  /** Where its value comes from now; "environment" is one this computer set, which the app can't change. */
  set: z.enum(["environment", "file"]).nullable(),
  /** Saved while its service couldn't be asked about it, so it hasn't been tried. */
  untried: z.boolean(),
  /**
   * The private field a secret is typed into (`POST /private/<field>`), under `key`: one field
   * holds each of an app's keys. Null for one the app only shows, or this computer sets.
   */
  field: z.string().nullable(),
  /** The variable that holds it, which the owner sets by hand for a `file` setting: "TELEGRAM_API_URL". */
  env: z.string(),
});
export type AppSettingWire = z.infer<typeof appSettingWireSchema>;

/**
 * The jobs an app can do for Auni itself, which "What Auni runs on" lists it under: thinking, keeping
 * the wallet's keys, trading (a swap route), moving cash (a bridge, a pay-in), pricing and naming
 * tokens, and watching the world.
 */
export const APP_JOBS = ["thinks", "keys", "trades", "moves", "prices", "watches"] as const;
export type AppJob = (typeof APP_JOBS)[number];

/** One thing the owner holds at an app, as its sheet lists it. */
const appHoldingWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  detail: z.string(),
  logoUrl: z.string().nullable(),
  usdValue: dollarsSchema,
});

/** Where the owner's money sits at an app, as of Auni's last reading of it. */
const appAccountWireSchema = z.object({
  /** Everything there in dollars; null when it couldn't be read just now. */
  usd: dollarsSchema.nullable(),
  /** Largest first. */
  holdings: z.array(appHoldingWireSchema),
  /** The specialists that hold something there, by name. */
  specialists: z.array(z.string()),
  /**
   * How money gets there and how it comes back: null when a move of the app's does it, which
   * Auni makes a card for when asked; else the app's own words on it.
   */
  moneyIn: z.string().nullable(),
  moneyOut: z.string().nullable(),
});

/**
 * One app as `GET /apps` lists it. Its mark, its ways to try it and its tools are in
 * APP_LISTINGS, by id; its name and its line come with it, since core may run an app this
 * build of the web never listed (the demo's stand-ins).
 */
const appWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** What it does for the owner, in a few words: "Trade with leverage". */
  does: z.string().nullable(),
  /** Whether the owner may turn it off: only one they act through, never one Auni itself runs on. */
  canSwitch: z.boolean(),
  /** False once the owner turned it off: the agent is offered nothing of it, and it doesn't listen. */
  on: z.boolean(),
  /** The jobs it does for Auni itself; none for one the owner only acts through. */
  jobs: z.array(z.enum(APP_JOBS)),
  /** False for a brain or a wallet app that another one is doing the job of now. */
  inUse: z.boolean(),
  /** How it stands now, when a line says more than "on": "On your Claude Max subscription". */
  standing: z.string().nullable(),
  /** What it still needs before it works, each as a line the owner reads: "Needs an Elfa API key". */
  needs: z.array(z.string()),
  /**
   * What keeps going wrong for it while Auni runs, until that work goes right again: its key out
   * of credits, or a piece of work that fails each time ("Not working", with what failed and the
   * service's words).
   */
  troubles: z.array(z.object({ short: z.string(), says: z.string() })),
  /**
   * A chat app: "unset" until it has what it needs to connect (its token), then "ready" to be
   * paired with the owner's chat, then "paired". Null for any other app.
   */
  pairing: z.enum(["unset", "ready", "paired"]).nullable(),
  settings: z.array(appSettingWireSchema),
  /** Where the owner's money sits there; null for an app that keeps none. */
  account: appAccountWireSchema.nullable(),
  /**
   * Why it can't be turned off now, as of the last reading: it holds leveraged positions only
   * its own tools can close. `PATCH /apps/:id` checks again, afresh.
   */
  stays: z.string().nullable(),
});
export type AppWire = z.infer<typeof appWireSchema>;

/**
 * Every app in this Auni, as `GET /apps` returns them, in id order, and where the owner's
 * settings file is, for a setting only that file changes: "~/.auni/.env".
 */
export const appsWireSchema = z.object({
  apps: z.array(appWireSchema),
  settingsFile: z.string(),
  /** Which brain answers, in one sentence; null with only one brain to pick from. */
  whichBrain: z.string().nullable(),
});
export type AppsWire = z.infer<typeof appsWireSchema>;

/** What `PATCH /apps/:id` takes: the switch, and nothing else. */
export const switchAppRequestSchema = z.object({ on: z.boolean() }).strict();
