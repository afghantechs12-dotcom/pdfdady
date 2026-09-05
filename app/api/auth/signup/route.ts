import { NextResponse } from "next/server";
import { z } from "zod";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import {
  AuthService,
  SESSION_MAX_AGE,
  USER_SESSION_COOKIE,
} from "@/src/application/services/AuthService";
import {
  authError,
  enforceRateLimit,
  readBoundedJson,
  sessionCookieOptions,
  signupRateLimiter,
} from "@/src/application/services/authHttp";
import {
  DEFAULT_AUTHENTICATED_PATH,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  safeRedirectPath,
  validateEmail,
  validateName,
  validateNewPassword,
  validatePasswordConfirmation,
} from "@/src/application/services/authValidation";
import { requireSameOrigin } from "@/src/application/services/workspaceCsrf";
import { toPublicUser } from "@/src/domain/entities/User";
import { DomainError } from "@/src/domain/errors";
import type { IAuditLogRepository } from "@/src/application/ports/auth/AuditLogRepository";
import type { IMetrics } from "@/src/application/ports/observability/Metrics";
import { clientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().max(MAX_NAME_LENGTH),
  email: z.string().max(MAX_EMAIL_LENGTH),
  password: z.string().max(MAX_PASSWORD_LENGTH),
  confirmPassword: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  next: z.string().max(512).optional(),
});

/**
 * POST /api/auth/signup — create the account, provision its tenant, sign in.
 *
 * The account is only useful once it owns an Organization and a default
 * Workspace, so `AuthService.register` provisions both transactionally and
 * idempotently before a session is issued. A retried signup therefore cannot
 * leave a half-built tenant or duplicate Workspaces behind.
 */
export async function POST(req: Request) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const limited = enforceRateLimit(req, signupRateLimiter, 3600);
  if (limited) return limited;

  const body = await readBoundedJson(req);
  if (!body.ok) return body.response;

  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return authError("INVALID_INPUT", "Check the form and try again.", 400);
  }

  // Server-side revalidation of every rule the client form enforces. The client
  // checks exist for feedback speed only; these are the ones that count.
  const { name, email, password, confirmPassword } = parsed.data;
  for (const check of [validateName(name), validateEmail(email), validateNewPassword(password)]) {
    if (!check.ok) return authError("INVALID_INPUT", check.message, 400);
  }
  if (confirmPassword !== undefined) {
    const match = validatePasswordConfirmation(password, confirmPassword);
    if (!match.ok) return authError("INVALID_INPUT", match.message, 400);
  }

  const auth = appContainer.resolve<AuthService>(Tokens.AuthService);
  const metrics = appContainer.resolve<IMetrics>(Tokens.Metrics);

  try {
    const { user, session } = await auth.register({ email, password, name });
    const audit = appContainer.resolve<IAuditLogRepository>(Tokens.AuditLogRepository);
    await audit.record({
      actorType: "user",
      actorId: user.id,
      action: "user.register",
      ip: clientIp(req),
    });
    metrics.increment("auth.signup.success", 1);

    const redirectTo = safeRedirectPath(parsed.data.next ?? null, DEFAULT_AUTHENTICATED_PATH);
    const res = NextResponse.json({ user: toPublicUser(user), redirectTo }, { status: 201 });
    res.cookies.set(USER_SESSION_COOKIE, session.token, sessionCookieOptions(SESSION_MAX_AGE));
    return res;
  } catch (err) {
    metrics.increment("auth.signup.failure", 1);
    if (err instanceof DomainError) {
      // Duplicate email is the one case we cannot hide: the user must be told
      // to sign in instead. Signup is rate-limited to blunt its use as an
      // enumeration oracle.
      const status = err.message.includes("already registered") ? 409 : 400;
      const code = status === 409 ? "EMAIL_TAKEN" : "INVALID_INPUT";
      return authError(code, err.message, status);
    }
    // Never surface the underlying error: it may name tables or constraints.
    return authError("PROVISIONING_FAILED", "We could not create your account. Please try again.", 500);
  }
}
