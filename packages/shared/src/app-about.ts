import { APP_ABOUTS } from "./apps.generated.ts";

/**
 * What an app tells the web about itself, as plain data. Each app's
 * `about.ts` (apps/core/src/apps/<id>/) is one of these, and `pnpm gen`
 * copies every one into apps.generated.ts, so the web knows each app's
 * name, mark and tool copy without importing any app code.
 */
export interface AppAbout {
  /** Must equal the app's folder name. */
  readonly id: string;
  /** "Hyperliquid". */
  readonly name: string;
  /**
   * What it does for the owner, in the few words under its name in the Apps list: "Trade with
   * leverage". At most 40 characters, with no full stop. Every app in `src/apps/` says it
   * (apps.test.ts).
   */
  readonly does?: string;
  /**
   * Ways to try it, as chips in its sheet: each starts a new chat with `prompt`, under `title`.
   * Only for an app the owner acts through.
   */
  readonly starts?: readonly AppStart[];
  /**
   * The tile its cards wear, and how its logo (logo.svg or logo.png in the app's folder) sits on
   * it. An app whose cards wear Auni's own marks leaves it out; its logo is then a whole tile by
   * itself, a square with its own background, and is worn in the Apps list only.
   */
  readonly mark?: {
    /** CSS colors for the tile and its inset ring. */
    readonly background: string;
    readonly ring: string;
    /** How the logo fills the tile, and how much of its width it takes (0 to 1). */
    readonly fit: "contain" | "cover";
    readonly size: number;
  };
  /**
   * Its logo is a glyph Auni drew for a part of Auni itself (the wallet's key, the price
   * watcher's pulse), not a service's own logo: one colour on nothing. The web draws it in the
   * look's ink on a tile of the look's, so it reads in every look.
   */
  readonly glyph?: true;
  /** Every tool the app gives the agent or records, by name. */
  readonly tools?: Readonly<Record<string, ToolMeta>>;
  /** A watch source's icon beside each of its watches. */
  readonly watchIcon?: ToolMeta["icon"];
  /**
   * The hosts its pictures come from (a market's logo, an outcome's image), which the web's
   * image server may then fetch: a hostname exact or `**.` plus a suffix, and a pathname a
   * prefix ending in `/**`, or else exact.
   */
  readonly images?: readonly { readonly hostname: string; readonly pathname: string }[];
  /** The settings it reads, by the name its code asks for each with (core's settings.ts). */
  readonly settings?: Readonly<Record<string, AppSetting>>;
  /**
   * GitHub handles ("@someone", or a team's "@org/team") who answer for this app beside
   * Auni's maintainers, such as a venue's owner on the protocol's team. `pnpm gen` writes them
   * into .github/CODEOWNERS, so they review every change to its folder.
   */
  readonly maintainers?: readonly string[];
}

/** One way to try an app: what its chip says, and the message that starts the chat. */
interface AppStart {
  /** "Long BTC with $50". */
  readonly title: string;
  /** "Open a long on BTC with $50 on Hyperliquid." */
  readonly prompt: string;
}

/** One setting an app reads: where its value is kept, and who may change it. */
export interface AppSetting {
  /**
   * The variable that holds it, in the environment or the owner's settings file. A secret's
   * starts with the app's id, so it can only be its own: "ELFA_AUTO_API_KEY".
   */
  readonly env: string;
  /** What the app calls it: "Elfa API key". */
  readonly label: string;
  /**
   * secret: a key or a token, which the owner types into the app and nothing reads back.
   * file: one the app shows and never changes, since it changes whom Auni trusts (a URL the
   * app talks to, whose account a brain bills): the owner sets it in their settings file.
   */
  readonly kind: "secret" | "file";
  /** The app does nothing until it is set. */
  readonly required?: boolean;
  /** One line on where the owner gets it. */
  readonly help?: string;
  /** The https page where the owner gets it, which a card asking for it opens from Get a key. */
  readonly link?: string;
}

export interface ToolMeta {
  /**
   * money: an action behind the permission gate. read: a lookup. recorded:
   * what the venue did by itself, which Auni reads back and records (a payout).
   * later: a move another's card showed coming later, which that card's tap allowed and Auni
   * runs by itself then (ExecuteResult.later in core): never offered to the agent.
   */
  readonly kind: "money" | "read" | "recorded" | "later";
  /** What the step says while it runs, once done, and if it failed; required unless recorded. */
  readonly copy?: readonly [running: string, completed: string, failed: string];
  /** A lookup's step icon. */
  readonly icon?: "search" | "chart" | "news" | "wallet" | "clock";
  /** Its card ticks "Sent" before it lands, by the transaction it keeps or where it lands. */
  readonly sends?: true;
}

/** An app as the web sees it: its meta, and where its logo is served. */
export interface AppListing extends AppAbout {
  readonly logo?: string;
}

/** Every app as the web sees it, in id order. */
export const APP_LISTINGS: readonly AppListing[] = Object.values(APP_ABOUTS);

/** One app as the web sees it, by id; undefined for an id no app has. */
export function appListing(id: string): AppListing | undefined {
  return Object.hasOwn(APP_ABOUTS, id)
    ? (APP_ABOUTS as Readonly<Record<string, AppListing>>)[id]
    : undefined;
}
