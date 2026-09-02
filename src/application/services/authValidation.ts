/**
 * Pure auth validation + redirect-safety helpers.
 *
 * Deliberately free of Next.js, Prisma and DI imports so the exact rules that
 * guard the authentication surface can be unit-tested in isolation and shared
 * verbatim between the API routes (server) and the auth forms (client). Keeping
 * one implementation is what stops server and client from disagreeing about
 * what a "valid email" or a "safe redirect" is.
 */

/** Maximum accepted length for each free-text auth field (defence in depth). */
export const MAX_EMAIL_LENGTH = 254;
export const MAX_NAME_LENGTH = 120;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** Maximum accepted JSON body size for an auth request, in bytes. */
export const MAX_AUTH_BODY_BYTES = 4 * 1024;

/** Where authenticated users land when no safe destination was requested. */
export const DEFAULT_AUTHENTICATED_PATH = "/workspaces";

/**
 * True when `value` contains a C0 control, DEL, a C1 control, or any Unicode
 * whitespace/separator.
 *
 * Implemented with code-point arithmetic rather than a character-class regex on
 * purpose: the literal control characters such a class needs are invisible in
 * source and are silently mangled by editors and patch tooling. `\s` covers the
 * common cases; the explicit list below adds the separators and zero-width
 * marks that browsers tolerate while parsing a URL but `\s` does not match
 * (U+FEFF in particular is a byte-order mark, not whitespace).
 */
function hasControlOrWhitespace(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f) return true; // C0 controls
    if (code === 0x7f) return true; // DEL
    if (code >= 0x80 && code <= 0x9f) return true; // C1 controls
    if (code === 0x00a0) return true; // no-break space
    if (code === 0x1680) return true; // ogham space mark
    if (code >= 0x2000 && code <= 0x200f) return true; // en quad … RLM
    if (code === 0x2028 || code === 0x2029) return true; // line/para separator
    if (code === 0x202f || code === 0x205f) return true; // narrow/medium space
    if (code === 0x2060) return true; // word joiner
    if (code === 0x3000) return true; // ideographic space
    if (code === 0xfeff) return true; // BOM / zero-width no-break space
  }
  return false;
}

/**
 * Canonical email normalization: NFKC, trimmed, lowercased.
 *
 * Applied on BOTH signup and login so that "  Ada@Example.COM " and
 * "ada@example.com" resolve to the same account and the unique index on
 * `users.email` actually prevents duplicates.
 */
export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/** Collapses internal whitespace and trims — used for the account holder name. */
export function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/**
 * Pragmatic email shape check: one "@", non-empty local part, a dotted domain,
 * no whitespace, within the RFC length bound. Intentionally not an RFC 5322
 * regex — that accepts addresses no provider will deliver to while rejecting
 * none of the inputs we actually care about.
 */
export function isValidEmail(value: string): boolean {
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  if (hasControlOrWhitespace(email)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/u.test(email);
}

export interface FieldResult {
  ok: boolean;
  /** User-facing message; empty when `ok` is true. */
  message: string;
}

const OK: FieldResult = { ok: true, message: "" };

export function validateEmail(value: string): FieldResult {
  if (normalizeEmail(value).length === 0) return { ok: false, message: "Enter your email address." };
  if (!isValidEmail(value)) return { ok: false, message: "Enter a valid email address." };
  return OK;
}

/**
 * Password policy for NEW passwords (signup). Login deliberately does not apply
 * this — an existing password that predates a policy change must still be able
 * to sign in, and re-validating it client-side leaks the policy needlessly.
 */
export function validateNewPassword(value: string): FieldResult {
  if (value.length === 0) return { ok: false, message: "Choose a password." };
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  return OK;
}

/** Login-side password check: presence and an upper bound only. */
export function validateExistingPassword(value: string): FieldResult {
  if (value.length === 0) return { ok: false, message: "Enter your password." };
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  return OK;
}

export function validatePasswordConfirmation(password: string, confirmation: string): FieldResult {
  if (confirmation.length === 0) return { ok: false, message: "Re-enter your password." };
  if (password !== confirmation) return { ok: false, message: "Passwords do not match." };
  return OK;
}

export function validateName(value: string): FieldResult {
  const name = normalizeName(value);
  if (name.length === 0) return { ok: false, message: "Enter your full name." };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `Use at most ${MAX_NAME_LENGTH} characters.` };
  }
  return OK;
}

/**
 * True when `path` addresses an authentication page or endpoint.
 *
 * Used to reject such a value as a post-login destination: redirecting an
 * authenticated user to /login (or to a POST-only /api/auth/* route) is either
 * an infinite loop or a 405, which is exactly the class of bug this module
 * exists to prevent.
 */
function isAuthPath(path: string): boolean {
  const withoutQuery = path.split(/[?#]/u)[0].replace(/\/+$/u, "").toLowerCase();
  return (
    withoutQuery === "/login" ||
    withoutQuery === "/signup" ||
    withoutQuery === "/register" ||
    withoutQuery.startsWith("/api/auth")
  );
}

/**
 * Returns a safe same-origin destination for a post-login redirect, or the
 * fallback when the candidate is missing or hostile.
 *
 * Open-redirect defence. A value is accepted ONLY when it is a relative path
 * beginning with a single "/" that cannot be reinterpreted as an absolute URL
 * by a browser. Rejected, specifically:
 *
 *   - absolute URLs ("https://evil.test", "http://evil.test")
 *   - scheme-relative URLs ("//evil.test") which browsers treat as absolute
 *   - backslash variants ("/\evil.test", "\\evil.test") — several browsers
 *     normalize "\" to "/" while parsing a URL
 *   - any value carrying a scheme ("javascript:", "data:", "vbscript:")
 *   - percent-encoded forms of all of the above, re-checked after decoding
 *   - control characters and whitespace used to smuggle past a prefix check
 *
 * The decoded forms are re-checked because "%2f%2fevil.test" passes a raw
 * startsWith("//") test yet is resolved by the browser as absolute.
 */
export function safeRedirectPath(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_AUTHENTICATED_PATH,
): string {
  if (typeof candidate !== "string") return fallback;
  const raw = candidate.trim();
  if (raw.length === 0 || raw.length > 512) return fallback;

  // Browsers strip tabs/newlines from URLs before parsing, so "/\t/evil.test"
  // would otherwise slip past the "//" check below.
  if (hasControlOrWhitespace(raw)) return fallback;

  const forms = [raw];
  let decoded = raw;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // A malformed percent-sequence is never a path we are willing to trust.
      return fallback;
    }
    if (next === decoded) break;
    decoded = next;
    forms.push(next);
  }

  for (const form of forms) {
    if (hasControlOrWhitespace(form)) return fallback;
    if (!form.startsWith("/")) return fallback;
    // "//host" and "/\host" both resolve as scheme-relative absolute URLs.
    if (form.startsWith("//") || form.startsWith("/\\")) return fallback;
    if (form.includes("\\")) return fallback;
    // A colon before the first path/query/fragment boundary implies a scheme.
    if (/^\/[^/?#]*:/u.test(form)) return fallback;
    // An auth page as the destination is always a loop: /login?next=/login
    // would send an authenticated user back to /login indefinitely.
    if (isAuthPath(form)) return fallback;
  }

  return raw;
}

/**
 * Generic, non-enumerable credential failure message.
 *
 * The SAME string is returned for "no such user" and "wrong password" so the
 * login endpoint cannot be used to discover which email addresses are
 * registered.
 */
export const GENERIC_CREDENTIAL_ERROR = "Email or password is incorrect.";
