import crypto from "node:crypto";

/**
 * Admin password hashing, verification, and first-run detection.
 *
 * Pure helpers backed only by `node:crypto`, so they can be unit-tested in
 * isolation and reused by the admin store, the login route, the
 * password-change route, and the first-run setup route WITHOUT pulling in the
 * full data layer (which drags in React `cache`, every `@/data/*` module, and
 * Next).
 *
 * Storage format is "salt:hash" (both hex). scrypt is used with a 16-byte
 * random salt and a 32-byte derived key. Verification is constant-time.
 *
 * Security note: scryptSync is CPU-bound and blocks the event loop briefly
 * (~tens of ms). That is acceptable for the low-frequency admin auth path
 * (login is rate-limited per IP). Moving to async scrypt is tracked as future
 * work; it is not on the Milestone 1 critical path.
 */

const KEY_LEN = 32;
const SALT_LEN = 16;

/** Produces a "salt:hash" string for `password`. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LEN).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Constant-time verification of `password` against a stored "salt:hash".
 * Returns false for empty/malformed stored values (never throws), so a
 * not-yet-configured admin password simply fails to verify.
 */
export function verifyPassword(password: string, stored: string | undefined | null): boolean {
  const [salt, hash] = (stored ?? "").split(":");
  if (!salt || !hash) return false;
  let candidateHash: string;
  try {
    candidateHash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  } catch {
    return false;
  }
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(candidateHash, "hex"),
    );
  } catch {
    // Length mismatch / non-hex stored value → never verify, never throw.
    return false;
  }
}

/**
 * True when an admin password has been configured (first-run setup complete).
 * An empty or malformed hash means no password is set yet — login must be
 * refused with a "setup required" signal and the operator must complete
 * `/admin/setup` first. This is the gate that lets us ship NO default password.
 */
export function isAdminPasswordSet(stored: string | undefined | null): boolean {
  return typeof stored === "string" && stored.length > 0 && stored.includes(":");
}
