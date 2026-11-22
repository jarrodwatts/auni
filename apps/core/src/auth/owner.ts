import { createHash, randomBytes } from "node:crypto";

import type { OwnerSessionWire } from "@auni/shared";
import { and, desc, eq, gt, lt, ne, or, sql } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import { owner, ownerSessions, type OwnerRow } from "../db/schema.ts";
import { env } from "../env.ts";

// Auni runs for one person: whoever can read what the hub prints is its owner, since they can
// read its keys too. A pairing code printed there turns one browser into the owner's for a
// long while; nothing else (not a request from this machine, not a guess) acts as the owner.
//
//   auni opens  WEB_ORIGIN/app#pair=<code>   (with nobody paired; `auni pair` prints one)
//        |      the code lives in the fragment, so no server log or Referer sees it
//        v
//   the app POSTs the code -> pair() spends it once -> a session token in an HttpOnly cookie
//        |      and goes on as the owner's: first run (their first take) until it's sent, then the app
//        v
//   every owner route: requireOwner looks the cookie's hash up here

/** How long a pairing code works. */
export const PAIRING_TTL_MS = 15 * 60_000;
/**
 * How long after pairing a browser has proved its owner is there (auth/proof.ts). Pairing needs
 * the terminal where Auni runs, which already reaches the keys, so it is the root of trust; an
 * old session, say a stolen cookie, proves nothing.
 */
const FRESH_PAIRING = sql`interval '15 minutes'`;
const SESSION_TTL_MS = 400 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "auni_session";

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The owner's settings: their name, time zone, brief and channels. */
export async function theOwner(executor: Pick<Tx, "select"> = db): Promise<OwnerRow> {
  return theRow(await executor.select().from(owner));
}

/**
 * The owner's settings, held for the rest of `tx`, so arrivals, news and other tokens record one
 * at a time, and a settings change waits for them.
 */
export async function lockOwner(tx: Tx): Promise<OwnerRow> {
  return theRow(await tx.select().from(owner).for("update"));
}

function theRow([row]: readonly OwnerRow[]): OwnerRow {
  if (!row) throw new Error("The owner's settings row is missing: the migrations make it.");
  return row;
}

/** A fresh one-time code; codes past their 15 minutes are cleared on the way. */
export async function mintPairingCode(
  label?: string | null,
  options: { readonly browserIssued?: boolean } = {},
): Promise<string> {
  const code = newToken();
  await db.delete(ownerSessions).where(lt(ownerSessions.expiresAt, sql`now()`));
  await db.insert(ownerSessions).values({
    tokenHash: hashOf(code),
    kind: "pairing",
    label: label?.trim() ? label.trim().slice(0, 64) : null,
    browserIssued: options.browserIssued ?? false,
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
  });
  return code;
}

/** The link that signs a browser in as the owner's, straight into the app, at `path` of it. */
export function pairingLink(code: string, path = "/app"): string {
  return `${env.WEB_ORIGIN}${path}#pair=${code}`;
}

/** Spends a pairing code: the new session's token, or null for a code that is wrong, spent or old. */
export async function pair(
  code: string,
  meta: { readonly label?: string | null; readonly userAgent?: string | null } = {},
): Promise<string | null> {
  return db.transaction(async (tx) => {
    // Serialize pairing with bulk session/link revocation so a concurrent revoke never misses a
    // session inserted from a pairing code redeemed mid-flight.
    await lockOwner(tx);
    // One statement, so two browsers racing with one code can't both pass.
    const [spent] = await tx
      .delete(ownerSessions)
      .where(
        and(
          eq(ownerSessions.tokenHash, hashOf(code)),
          eq(ownerSessions.kind, "pairing"),
          gt(ownerSessions.expiresAt, sql`now()`),
        ),
      )
      .returning({
        id: ownerSessions.id,
        label: ownerSessions.label,
        browserIssued: ownerSessions.browserIssued,
      });
    if (!spent) return null;
    const session = newToken();
    const now = new Date();
    await tx.insert(ownerSessions).values({
      tokenHash: hashOf(session),
      kind: "session",
      label: meta.label ?? spent.label ?? null,
      userAgent: meta.userAgent?.slice(0, 240) ?? null,
      browserIssued: spent.browserIssued,
      lastSeenAt: now,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return session;
  });
}

/**
 * The live session a token holds, or null when the token isn't live: whether its browser paired
 * from the terminal in the last 15 minutes. Browser-issued pairing links never grant step-up
 * proof, so the terminal stays the single root of trust. The database judges freshness by its
 * own clock, which also stamped the pairing, so no other clock's drift can make a session fresh.
 */
export async function sessionOf(
  token: string,
): Promise<{ readonly id: string; readonly freshlyPaired: boolean } | null> {
  const [session] = await db
    .select({
      id: ownerSessions.id,
      freshlyPaired: sql<boolean>`not ${ownerSessions.browserIssued} and ${ownerSessions.createdAt} > now() - ${FRESH_PAIRING}`,
      lastSeenAt: ownerSessions.lastSeenAt,
    })
    .from(ownerSessions)
    .where(
      and(
        eq(ownerSessions.tokenHash, hashOf(token)),
        eq(ownerSessions.kind, "session"),
        gt(ownerSessions.expiresAt, sql`now()`),
      ),
    );
  if (!session) return null;
  // Touch lastSeenAt at most once every 5 minutes so Settings -> Remote access shows fresh activity without write noise.
  if (!session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    void db
      .update(ownerSessions)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(ownerSessions.id, session.id))
      .catch(() => undefined);
  }
  return { id: session.id, freshlyPaired: session.freshlyPaired };
}

/** Active paired browser sessions, newest first, marking which one belongs to this request. */
export async function listSessions(currentSessionId?: string): Promise<OwnerSessionWire[]> {
  const rows = await db
    .select({
      id: ownerSessions.id,
      label: ownerSessions.label,
      userAgent: ownerSessions.userAgent,
      createdAt: ownerSessions.createdAt,
      lastSeenAt: ownerSessions.lastSeenAt,
      freshlyPaired: sql<boolean>`not ${ownerSessions.browserIssued} and ${ownerSessions.createdAt} > now() - ${FRESH_PAIRING}`,
    })
    .from(ownerSessions)
    .where(and(eq(ownerSessions.kind, "session"), gt(ownerSessions.expiresAt, sql`now()`)))
    .orderBy(desc(ownerSessions.createdAt));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    current: row.id === currentSessionId,
    freshlyPaired: row.freshlyPaired,
  }));
}

/** Revokes a single paired browser session by id (refuses to revoke the caller's own session). */
export async function revokeSession(id: string, currentSessionId?: string): Promise<boolean> {
  if (currentSessionId && id === currentSessionId) return false;
  const deleted = await db
    .delete(ownerSessions)
    .where(and(eq(ownerSessions.id, id), eq(ownerSessions.kind, "session")))
    .returning({ id: ownerSessions.id });
  return deleted.length > 0;
}

/**
 * Revokes every paired browser session except the caller's current one, plus any outstanding
 * browser-issued pairing links; returns how many active sessions were revoked.
 */
export async function revokeOtherSessions(currentSessionId?: string): Promise<number> {
  return db.transaction(async (tx) => {
    await lockOwner(tx);
    const sessionsWhere = currentSessionId
      ? and(eq(ownerSessions.kind, "session"), ne(ownerSessions.id, currentSessionId))
      : eq(ownerSessions.kind, "session");
    const deleted = await tx
      .delete(ownerSessions)
      .where(
        or(
          sessionsWhere,
          and(eq(ownerSessions.kind, "pairing"), eq(ownerSessions.browserIssued, true)),
        ),
      )
      .returning({ id: ownerSessions.id, kind: ownerSessions.kind });
    return deleted.filter((row) => row.kind === "session").length;
  });
}

/**
 * When the newest browser still signed in paired, or null with none: `auni` opens a pairing link
 * when there is none, and setup reads whether any browser is the owner's yet.
 */
export async function lastPaired(): Promise<Date | null> {
  const [session] = await db
    .select({ at: ownerSessions.createdAt })
    .from(ownerSessions)
    .where(and(eq(ownerSessions.kind, "session"), gt(ownerSessions.expiresAt, sql`now()`)))
    .orderBy(desc(ownerSessions.createdAt))
    .limit(1);
  return session?.at ?? null;
}

/**
 * Signs every browser out and revokes any unused browser-issued pairing links, for a lost or
 * shared device; pairing again from the terminal lets the owner back in.
 */
export async function signOutEverywhere(): Promise<void> {
  await db.transaction(async (tx) => {
    await lockOwner(tx);
    await tx
      .delete(ownerSessions)
      .where(or(eq(ownerSessions.kind, "session"), eq(ownerSessions.browserIssued, true)));
  });
}

/** The cookie that carries a session: host-only, never readable by script, never sent cross-site. */
export function sessionCookie(token: string): string {
  const secure = env.WEB_ORIGIN.startsWith("https:") ? "; Secure" : "";
  const maxAge = Math.floor(SESSION_TTL_MS / 1_000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
