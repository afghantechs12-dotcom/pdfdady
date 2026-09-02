import { POST as signupPost } from "../signup/route";

/**
 * POST /api/auth/register — backwards-compatible alias for /api/auth/signup.
 *
 * The canonical endpoint is `/api/auth/signup` (it matches the `/signup` page
 * and the rest of the auth surface). This module delegates to that handler so
 * any existing client or bookmark pointing at `/register` keeps working with
 * identical validation, provisioning, rate limiting and cookie behaviour rather
 * than drifting into a second, subtly different signup path.
 *
 * `runtime`/`dynamic` are declared literally rather than re-exported: Next
 * parses these statically at build time and rejects a re-export.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = signupPost;
