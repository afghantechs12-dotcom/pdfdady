/**
 * Admin session tokens — HMAC-signed, stateless, and verifiable in BOTH the
 * Edge proxy runtime and the Node.js API routes. We use Web Crypto (available
 * in both runtimes) rather than node:crypto so the exact same helper guards the
 * middleware and the route handlers.
 *
 * A token is `"<issuedAtMs>.<hmacHex>"`. The signature is
 * HMAC-SHA256(secret, issuedAtMs). Verification recomputes the signature,
 * compares it in constant time, and rejects tokens older than MAX_AGE_MS.
 *
 * The secret comes from `ADMIN_SECRET`, which is REQUIRED in every environment
 * (a public fallback would make every admin cookie forgeable). The only escape
 * hatch is an explicit local-dev opt-in via PDFDADI_ALLOW_INSECURE_DEV_SECRET=1,
 * meant solely for `next dev` on a developer's own machine.
 */

export const ADMIN_COOKIE = "pdfdadi_admin";

const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
/**
 * The public dev fallback. Exported ONLY so the production configuration gate
 * (src/infrastructure/config/env.ts) can refuse a deployment that sets
 * ADMIN_SECRET to this value — it ships in the repo, so it is a known secret.
 * Sharing the constant means the gate cannot drift from the value it rejects.
 */
export const INSECURE_DEV_SECRET =
  "pdfdadi-dev-secret-set-ADMIN_SECRET-in-production";

let warnedAboutFallback = false;

function getSecret(): string {
  const secret = process.env.ADMIN_SECRET;
  if (secret && secret.length >= 8) return secret;
  // ADMIN_SECRET is required in EVERY environment — the fallback string ships
  // in the public repo, so any environment using it has forgeable admin
  // cookies (full admin takeover with no password and no rate limit). The only
  // exception is an EXPLICIT local-dev opt-in via
  // PDFDADI_ALLOW_INSECURE_DEV_SECRET=1, meant only for `next dev` on a
  // developer's own machine.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.PDFDADI_ALLOW_INSECURE_DEV_SECRET === "1"
  ) {
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      console.warn(
        "[security] ADMIN_SECRET is not set — using the PUBLIC dev fallback because PDFDADI_ALLOW_INSECURE_DEV_SECRET=1. Admin cookies are forgeable. Set ADMIN_SECRET in .env.local for local dev.",
      );
    }
    return INSECURE_DEV_SECRET;
  }
  throw new Error(
    "ADMIN_SECRET must be set to a value of at least 8 characters (admin sessions are forgeable without it). For local dev, set it in .env.local, or set PDFDADI_ALLOW_INSECURE_DEV_SECRET=1 to use the insecure fallback.",
  );
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sign(payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(new Uint8Array(sig));
}

/** Constant-time comparison of two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Issues a fresh signed session token for a successful login. */
export async function createSessionToken(now = Date.now()): Promise<string> {
  const issuedAt = String(now);
  const sig = await sign(issuedAt);
  return `${issuedAt}.${sig}`;
}

/** Returns true if the token is well-formed, correctly signed and not expired. */
export async function verifySessionToken(
  token: string | undefined | null,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const issuedAt = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  if (!/^\d+$/.test(issuedAt) || !/^[0-9a-f]+$/.test(providedSig)) return false;

  const issuedMs = Number(issuedAt);
  if (!Number.isFinite(issuedMs)) return false;
  if (now - issuedMs > MAX_AGE_MS) return false;
  if (issuedMs - now > 60_000) return false; // reject implausible future tokens

  const expectedSig = await sign(issuedAt);
  return timingSafeEqual(providedSig, expectedSig);
}

/** Extracts the admin cookie value from a raw Cookie header. */
export function readAdminCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === ADMIN_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}
