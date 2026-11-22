import { jwtVerify, SignJWT } from "jose";

// Lets the agent call Auni's tools (core's MCP server) for one turn, and nothing else.
const ALGORITHM = "HS256";
// Outlives the longest turn; the middleware refuses a token once its turn has ended.
export const TURN_TOKEN_TTL_SECONDS = 60 * 60;

export interface TurnTokenClaims {
  readonly threadId: string;
  /** The thread's running marker for this turn; the token works only while the thread still holds it. */
  readonly turnStartedAt: string;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signTurnToken(
  claims: TurnTokenClaims,
  secret: string,
  ttlSeconds = TURN_TOKEN_TTL_SECONDS,
): Promise<string> {
  // Absolute expiry so a non-positive ttl expresses an already-expired token in tests.
  const expiresAt = Math.floor(Date.now() / 1_000) + ttlSeconds;
  return new SignJWT({
    thread_id: claims.threadId,
    turn_started_at: claims.turnStartedAt,
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key(secret));
}

export async function verifyTurnToken(token: string, secret: string): Promise<TurnTokenClaims> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: [ALGORITHM] });
  const { thread_id: threadId, turn_started_at: turnStartedAt } = payload;
  if (typeof threadId !== "string" || typeof turnStartedAt !== "string")
    throw new Error("Turn token is missing required claims.");
  return { threadId, turnStartedAt };
}
