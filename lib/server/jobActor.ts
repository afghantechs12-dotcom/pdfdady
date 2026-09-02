import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { AuthService, USER_SESSION_COOKIE } from "@/src/application/services/AuthService";
import type { JobActor } from "@/src/application/services/jobOwnership";

/**
 * Cookie holding the anonymous job identity.
 *
 * Separate from the session cookie on purpose: it must survive sign-out and
 * sign-in without granting anything, and it carries no authentication meaning —
 * only "these jobs are the same visitor's jobs".
 */
export const ANON_JOB_COOKIE = "pdfdadi_jid";

/** 30 days, matching the session cookie so the two expire on a similar horizon. */
const ANON_JOB_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Resolves the caller's job identity from the request, server-side.
 *
 * A signed-in user is identified by validating their session against the
 * database — the presence of a cookie is not proof of a session, only a lookup
 * is. Everyone else gets a random, opaque, HttpOnly identifier, minted here on
 * first use.
 *
 * Nothing in this function reads the request body. That is the point: a job's
 * owner is whoever the server says is calling, so a crafted
 * `{"userId": "...someone else..."}` in a POST body cannot reassign ownership.
 */
export async function resolveJobActor(): Promise<JobActor> {
  const store = await cookies();

  const token = store.get(USER_SESSION_COOKIE)?.value;
  if (token) {
    const user = await appContainer
      .resolve<AuthService>(Tokens.AuthService)
      .getMe(token);
    if (user) return { ownerType: "user", ownerId: user.id, workspaceId: null };
  }

  const existing = store.get(ANON_JOB_COOKIE)?.value;
  if (existing && isPlausibleAnonId(existing)) {
    return { ownerType: "anon", ownerId: existing, workspaceId: null };
  }

  const minted = randomUUID();
  // Route Handlers may set cookies; a Server Component render cannot. Failing to
  // persist is not fatal — the job is still created and owned by `minted`, the
  // visitor just cannot address it on a later request. Better than throwing on a
  // read-only render path.
  try {
    store.set(ANON_JOB_COOKIE, minted, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ANON_JOB_COOKIE_MAX_AGE,
    });
  } catch {
    // Read-only cookie store — see above.
  }
  return { ownerType: "anon", ownerId: minted, workspaceId: null };
}

/**
 * Rejects a malformed anonymous id before it becomes an owner value.
 *
 * The cookie is HttpOnly but still attacker-supplied over the wire, and it ends
 * up in an index and in log context. Constraining it to the shape we mint keeps
 * junk out of both.
 */
function isPlausibleAnonId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
