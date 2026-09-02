import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { AuthService, USER_SESSION_COOKIE } from "./AuthService";
import { DEFAULT_AUTHENTICATED_PATH, safeRedirectPath } from "./authValidation";
import type { User } from "@/src/domain/entities/User";

/**
 * Server-side session helpers for App Router pages.
 *
 * Pages validate the session against the database through these helpers rather
 * than trusting anything client-side — the presence of a cookie is not proof of
 * a live session, only a lookup is.
 */

/** Reads and validates the session cookie. Returns null when not signed in. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(USER_SESSION_COOKIE)?.value;
  if (!token) return null;
  return appContainer.resolve<AuthService>(Tokens.AuthService).getMe(token);
}

/**
 * Builds the login URL for an unauthenticated visitor to `intendedPath`.
 *
 * The destination is passed as a `next` query parameter and is re-validated by
 * `safeRedirectPath` on the way back out, so a crafted link cannot turn the
 * login page into an open redirect.
 */
export function loginRedirectUrl(intendedPath: string): string {
  const safe = safeRedirectPath(intendedPath, DEFAULT_AUTHENTICATED_PATH);
  return `/login?next=${encodeURIComponent(safe)}`;
}

/**
 * Requires an authenticated user, else redirects to the login PAGE.
 *
 * THE 405 FIX. This previously redirected to `/api/auth/login`, an endpoint that
 * exports only POST. A Next.js `redirect()` makes the browser perform a
 * top-level GET navigation, so every unauthenticated visit to /workspaces became
 * `GET /api/auth/login` → 405 Method Not Allowed. A page redirect must always
 * target a page; the API route is reached only by the login form's fetch().
 */
export async function requireUser(intendedPath: string): Promise<User> {
  const user = await currentUser();
  if (!user) redirect(loginRedirectUrl(intendedPath));
  return user;
}

/**
 * Guard for the auth pages themselves: an already-signed-in visitor to /login
 * or /signup is sent straight to their workspaces instead of being shown a form
 * they do not need.
 */
export async function redirectIfAuthenticated(next?: string | null): Promise<void> {
  const user = await currentUser();
  if (user) redirect(safeRedirectPath(next ?? null, DEFAULT_AUTHENTICATED_PATH));
}
