import { z } from "zod";

/** The owner as `GET /me` and `PATCH /me` return them. */
export const meSchema = z.object({
  name: z.string().nullable(),
  timeZone: z.string(),
  /** The wallet's addresses, which Add money shows; null on a chain it holds no key for. */
  wallets: z.object({ evm: z.string().nullable(), solana: z.string().nullable() }),
  /**
   * The network whose address the wallet can make beside the one it holds, which Settings offers
   * (`POST /me/wallet/missing`): a wallet brought with one key alone. Null for one that holds both,
   * or can't.
   */
  walletLacks: z.enum(["evm", "solana"]).nullable(),
  /**
   * The private field that brings in a Solana key the owner already holds, beside the wallet's
   * EVM key (`wallet-solana`), while the wallet takes one; null otherwise.
   */
  bringSolana: z.string().nullable(),
  /** What turns think with, on what login; or, with none ready, what the owner runs. */
  brain: z.discriminatedUnion("ready", [
    z.object({
      ready: z.literal(true),
      name: z.string(),
      login: z.string(),
      /** At its usage limit until then, with no other brain ready meanwhile. */
      restingUntil: z.iso.datetime({ offset: true }).optional(),
    }),
    z.object({ ready: z.literal(false), fixes: z.array(z.string()) }),
  ]),
  /** The chat apps Auni can talk in: whether each is set up on this machine, and paired. */
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      configured: z.boolean(),
      paired: z.boolean(),
    }),
  ),
  /**
   * Where what Auni says unasked goes besides the web app: a paired channel's id, "web" for the
   * web app alone, or null for wherever they last talked to Auni.
   */
  home: z.string().nullable(),
  /** The owner sent their first take; until they do, the app is that take's question. */
  welcomed: z.boolean(),
  /** How the owner reaches Auni, and whether the machine it runs on keeps it running. */
  reach: z.object({
    /** From the owner's devices through Tailscale (always on), or a browser on this computer. */
    through: z.enum(["tailscale", "this-computer"]),
    /** Where the owner opens it. */
    address: z.string(),
    /** The Tailscale login it answers, always on. */
    owner: z.string().nullable(),
    staysOn: z.object({ stays: z.boolean(), laptop: z.boolean(), says: z.string() }),
  }),
  /**
   * The ask for a star on GitHub: `waiting` for a move of theirs to land, then `ask` until they
   * answer on any device, then `answered` for good.
   */
  starPrompt: z.enum(["waiting", "ask", "answered"]),
});
export type Me = z.infer<typeof meSchema>;

/**
 * What `POST /me/star/check` and `POST /me/star` found: whether the owner's GitHub account has
 * starred Auni, or null when their GitHub CLI couldn't say (missing, signed out, offline).
 */
export const starredSchema = z.object({ starred: z.boolean().nullable() });

/** The wallet's private keys, as `POST /me/keys` hands them over once the owner proved it's them. */
export const walletKeysResponseSchema = z.object({
  keys: z.object({ evm: z.string().nullable(), solana: z.string().nullable() }),
});

/**
 * The old names Chrome still gives some zones, by their current ones. Some Postgres
 * builds know only the current names (their tzdata leaves the old ones out), so
 * "Asia/Calcutta" saved as is would fail every query that reads their day. These
 * are every zone Node's own Intl names that such a Postgres doesn't.
 */
const CURRENT_ZONE_NAMES: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** A zone by its current name: "Asia/Calcutta" is "Asia/Kolkata". */
export function currentZoneName(zone: string): string {
  return CURRENT_ZONE_NAMES[zone] ?? zone;
}

/**
 * An IANA time zone such as "Australia/Sydney", as a browser names its own:
 * one Intl knows, and never a bare offset such as "+10:00", which Postgres
 * would read with its sign flipped. An old name is saved under its current one.
 */
const timeZoneSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z][\w+\-/]*$/u)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Not a time zone.")
  .transform(currentZoneName);

/** The body `PATCH /me` accepts. Every field is optional; absent means unchanged. */
export const updateMeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).nullable(),
    /** Web sends the browser's own whenever it differs, so "today" starts at their midnight. */
    time_zone: timeZoneSchema,
    /** As `home` reads; a channel must be paired. */
    home_channel: z.string().max(64).nullable(),
  })
  .partial();
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
