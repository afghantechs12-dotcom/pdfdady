import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { AuthService, USER_SESSION_COOKIE } from "@/src/application/services/AuthService";
import { authError, clearedSessionCookieOptions } from "@/src/application/services/authHttp";
import { toPublicUser } from "@/src/domain/entities/User";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me — the authenticated user, or 401.
 *
 * GET is correct here: this is a read with no side effects. The response passes
 * through `toPublicUser`, which is the only sanctioned way to serialize a user
 * and omits `passwordHash` by construction. The session token is never echoed
 * back — the client already holds it in an HttpOnly cookie and has no need for
 * its value.
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(USER_SESSION_COOKIE)?.value;
  if (!token) return authError("UNAUTHORIZED", "Authentication is required.", 401);

  const auth = appContainer.resolve<AuthService>(Tokens.AuthService);
  const user = await auth.getMe(token);
  if (!user) {
    // Expired or forged token: clear the stale cookie so the browser stops
    // resending a credential that will never work again.
    const res = authError("UNAUTHORIZED", "Your session has expired. Please sign in again.", 401);
    res.cookies.set(USER_SESSION_COOKIE, "", clearedSessionCookieOptions());
    return res;
  }

  return NextResponse.json({ user: toPublicUser(user) });
}
