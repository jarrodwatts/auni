import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

// What keeps a handover's bundle (the database, the wallet's keys, the owner's settings) to the one
// machine the owner gave the code to. The laptop makes a one-time code and shows it to the owner
// inside the command they run on the new machine. Both sides stretch the code with scrypt into
// two unrelated 32-byte keys:
//
//   proof   sent by the new machine to show it holds the code; the laptop compares it
//   seal    never sent: AES-256-GCM seals the bundle with it, so only the code's holder opens it
//
// A sealed bundle is   [12-byte nonce][ciphertext][16-byte tag]   and opens whole or not at all.

/** The code's letters: Crockford's base32, which has no I, L, O or U to misread. */
const LETTERS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 32 letters of 5 bits each: 160 bits, far past guessing within the code's 15 minutes. */
const CODE_LENGTH = 32;
/** Fixed, since each code is random and used once: the salt only keeps these keys Auni's own. */
const SALT = "auni handover v1";
/** Bound into the seal, so a bundle can't be passed off as anything else sealed with the key. */
const SEALED_FOR = Buffer.from("auni handover v1 bundle");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A new one-time code, grouped in fours for reading: "7KQ2-M9XD-...". */
export function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  const letters = [...bytes].map((byte) => LETTERS[byte % 32]).join("");
  return letters.match(/.{4}/gu)!.join("-");
}

/** The code as typed or pasted, read leniently (case, dashes, spaces), or null if it isn't one. */
export function readCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[\s-]/gu, "");
  if (letters.length !== CODE_LENGTH) return null;
  return [...letters].every((letter) => LETTERS.includes(letter)) ? letters : null;
}

export interface HandoverKeys {
  readonly proof: Buffer;
  readonly seal: Buffer;
}

/** The two keys a code stands for (see the top of this file). Throws for text that isn't a code. */
export async function keysFor(code: string): Promise<HandoverKeys> {
  const letters = readCode(code);
  if (!letters) throw new Error("That isn't a handover code.");
  const derived = await new Promise<Buffer>((resolve, reject) =>
    // N = 2^15 takes about 32 MB and a tenth of a second: cheap once, costly a million times.
    scrypt(letters, SALT, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
  return { proof: derived.subarray(0, 32), seal: derived.subarray(32) };
}

/** Whether a proof sent matches the code's, compared in constant time. */
export function proves(sent: string, keys: HandoverKeys): boolean {
  const given = Buffer.from(sent, "base64url");
  return given.length === keys.proof.length && timingSafeEqual(given, keys.proof);
}

/** The proof as the new machine sends it. */
export const proofText = (keys: HandoverKeys): string => keys.proof.toString("base64url");

/** `plain`, sealed with the code's seal key. */
export function seal(keys: HandoverKeys, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.seal, nonce);
  cipher.setAAD(SEALED_FOR);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** A sealed bundle that didn't open: cut short, changed, or sealed with another code. */
export class SealBroken extends Error {
  constructor() {
    super("The bundle from your laptop didn't open: it was cut short or changed on the way.");
  }
}

/** What `seal` sealed, checked whole before any of it is returned. */
export function open(keys: HandoverKeys, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new SealBroken();
  const decipher = createDecipheriv("aes-256-gcm", keys.seal, sealed.subarray(0, NONCE_BYTES));
  decipher.setAAD(SEALED_FOR);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new SealBroken();
  }
}
