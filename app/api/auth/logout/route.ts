import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { AuthService, USER_SESSION_COOKIE } from "@/src/application/services/AuthService";
import { clearedSessionCookieOptions } from "@/src/application/services/authHttp";
import { requireSameOrigin } from "@/src/application/services/workspaceCsrf";
import type { IAuditLogRepository } from "@/src/application/ports/auth/AuditLogRepository";
import { clientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout — invalidate the server-side session and clear the
 * cookie.
 *
 * POST (not GET) plus a same-origin check, because a GET logout can be
 * triggered by any third-party <img src="/api/auth/logout">, letting an
 * attacker forcibly sign a user out. Server-side invalidation is the
 * substantive part: clearing the cookie alone would leave a still-valid token
 * usable by anyone who had captured it.
 */
export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const token = req.cookies.get(USER_SESSION_COOKIE)?.value;
  const auth = appContainer.resolve<AuthService>(Tokens.AuthService);

  if (token) {
    const user = await auth.getMe(token);
    if (user) {
      const audit = appContainer.resolve<IAuditLogRepository>(Tokens.AuditLogRepository);
      await audit.record({
        actorType: "user",
        actorId: user.id,
        action: "user.logout",
        ip: clientIp(req),
      });
    }
    // Deletes the row, so the token is dead even if the cookie survives.
    await auth.logout(token);
  }

  // Always report success: whether a valid session existed is not information
  // the caller needs, and the end state ("you are signed out") is identical.
  const res = NextResponse.json({ ok: true, redirectTo: "/login" });
  res.cookies.set(USER_SESSION_COOKIE, "", clearedSessionCookieOptions());
  return res;
}
