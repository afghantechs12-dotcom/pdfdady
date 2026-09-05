import { NextResponse } from "next/server";
import { z } from "zod";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import {
  AuthService,
  SESSION_MAX_AGE,
  SESSION_SHORT_MAX_AGE,
  USER_SESSION_COOKIE,
} from "@/src/application/services/AuthService";
import {
  authError,
  enforceRateLimit,
  loginRateLimiter,
  readBoundedJson,
  sessionCookieOptions,
} from "@/src/application/services/authHttp";
import {
  GENERIC_CREDENTIAL_ERROR,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  safeRedirectPath,
} from "@/src/application/services/authValidation";
import { requireSameOrigin } from "@/src/application/services/workspaceCsrf";
import { toPublicUser } from "@/src/domain/entities/User";
import type { IAuditLogRepository } from "@/src/application/ports/auth/AuditLogRepository";
import type { IMetrics } from "@/src/application/ports/observability/Metrics";
import type { IAnalytics } from "@/src/application/ports/observability/Analytics";
import { clientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().max(MAX_EMAIL_LENGTH),
  password: z.string().max(MAX_PASSWORD_LENGTH),
  rememberMe: z.boolean().optional(),
  next: z.string().max(512).optional(),
});

/**
 * POST /api/auth/login — verify credentials, issue a session cookie.
 *
 * Only POST is exported. A GET here previously produced the 405 that broke the
 * whole flow, because a server-side `redirect("/api/auth/login")` sent the
 * browser to navigate (GET) to a POST-only route. Unauthenticated users are now
 * redirected to the `/login` PAGE; this endpoint only ever receives the form's
 * fetch(). Credentials are never accepted on a GET, where they would land in
 * the URL, browser history and access logs.
 */
export async function POST(req: Request) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const limited = enforceRateLimit(req, loginRateLimiter, 60);
  if (limited) return limited;

  const body = await readBoundedJson(req);
  if (!body.ok) return body.response;

  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    // Deliberately generic: field-level detail here would reveal whether the
    // email was well-formed enough to be looked up.
    return authError("INVALID_INPUT", GENERIC_CREDENTIAL_ERROR, 400);
  }

  const auth = appContainer.resolve<AuthService>(Tokens.AuthService);
  const metrics = appContainer.resolve<IMetrics>(Tokens.Metrics);
  const analytics = appContainer.resolve<IAnalytics>(Tokens.Analytics);

  let result: Awaited<ReturnType<AuthService["login"]>>;
  try {
    result = await auth.login(parsed.data.email, parsed.data.password, {
      rememberMe: parsed.data.rememberMe === true,
    });
  } catch {
    metrics.increment("auth.login.error", 1);
    return authError("INTERNAL_ERROR", "Sign-in failed. Please try again.", 500);
  }

  if (!result) {
    metrics.increment("auth.login.failure", 1);
    // Same status and same message for unknown-email and wrong-password.
    return authError("INVALID_CREDENTIALS", GENERIC_CREDENTIAL_ERROR, 401);
  }

  metrics.increment("auth.login.success", 1);
  analytics.track("user.login", { userId: result.user.id });
  const audit = appContainer.resolve<IAuditLogRepository>(Tokens.AuditLogRepository);
  await audit.record({
    actorType: "user",
    actorId: result.user.id,
    action: "user.login",
    ip: clientIp(req),
  });

  // The redirect target is resolved server-side so a tampered `next` cannot
  // bounce a freshly-authenticated user to an attacker-controlled origin.
  const redirectTo = safeRedirectPath(parsed.data.next ?? null);
  const res = NextResponse.json({ user: toPublicUser(result.user), redirectTo });
  res.cookies.set(
    USER_SESSION_COOKIE,
    result.session.token,
    sessionCookieOptions(parsed.data.rememberMe === true ? SESSION_MAX_AGE : SESSION_SHORT_MAX_AGE),
  );
  return res;
}
