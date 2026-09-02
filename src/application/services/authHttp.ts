import { NextResponse } from "next/server";
import { USER_SESSION_COOKIE } from "./AuthService";
import { MAX_AUTH_BODY_BYTES } from "./authValidation";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";

/**
 * Shared plumbing for the /api/auth/* routes: cookie policy, bounded body
 * reading, rate limiting and error shaping.
 *
 * Centralized so the session cookie cannot be set with different flags on
 * different routes — a mismatch there is exactly how a Secure/HttpOnly
 * guarantee silently regresses.
 */

/** Machine-readable failure codes the auth UI maps to human copy. */
export type AuthErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "INVALID_CREDENTIALS"
  | "EMAIL_TAKEN"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "CSRF_ORIGIN_REJECTED"
  | "UNAUTHORIZED"
  | "PROVISIONING_FAILED"
  | "INTERNAL_ERROR";

export function authError(code: AuthErrorCode, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Session cookie attributes.
 *
 *  - httpOnly: script cannot read the token, so XSS cannot exfiltrate a session
 *  - sameSite "lax": the cookie is withheld from cross-site POSTs (CSRF) while
 *    still surviving a top-level navigation back into the app
 *  - secure in production: never transmitted over plaintext HTTP. Left off in
 *    development because localhost is not HTTPS and the cookie would be dropped
 *  - path "/": the session applies to the whole app
 */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/** Attributes for clearing the cookie; must mirror the set attributes. */
export function clearedSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  };
}

export { USER_SESSION_COOKIE };

/**
 * Reads a JSON body, rejecting anything larger than `MAX_AUTH_BODY_BYTES`.
 *
 * The declared Content-Length is checked first (cheap), then the actual decoded
 * text is measured — a chunked request can omit or understate the header, so
 * trusting it alone would let an attacker stream an unbounded body into
 * JSON.parse and exhaust memory.
 */
export async function readBoundedJson(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_AUTH_BODY_BYTES) {
    return {
      ok: false,
      response: authError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413),
    };
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: authError("INVALID_JSON", "Request body could not be read.", 400) };
  }

  if (new TextEncoder().encode(text).length > MAX_AUTH_BODY_BYTES) {
    return {
      ok: false,
      response: authError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413),
    };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: authError("INVALID_JSON", "Request body is not valid JSON.", 400) };
  }
}

/**
 * Per-IP fixed-window limiters for the credential endpoints.
 *
 * Login is the tighter bound because it is the endpoint worth brute-forcing.
 * These are in-process (single-instance) guards — behind multiple instances the
 * effective limit multiplies, so a shared limiter at the edge is still wanted.
 */
export const loginRateLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });
export const signupRateLimiter = new RateLimiter({ windowMs: 60 * 60_000, max: 10 });

export function enforceRateLimit(req: Request, limiter: RateLimiter, retryAfterSeconds: number) {
  if (!limiter.hit(clientIp(req))) return null;
  return NextResponse.json(
    {
      error: {
        code: "RATE_LIMITED" satisfies AuthErrorCode,
        message: "Too many attempts. Please wait and try again.",
      },
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
