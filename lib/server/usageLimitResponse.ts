import { NextResponse } from "next/server";

import type { UsageLimitError } from "@/src/application/services/UsageMeteringService";

/**
 * The one shape a refused submission takes, shared by both submit routes.
 *
 * ## What is deliberately not in the body
 *
 * `reason` is the closed denial vocabulary — `meter_exhausted`, `file_too_large`,
 * `too_many_concurrent` — which is all a client needs to recognise a quota refusal
 * and show the right panel. The error's `meter`, `limit` and `used` are dropped on
 * purpose: a meter key is an internal counter identifier, and the pair
 * (limit, used) is the counter implementation showing through a public response. A
 * client that wants the numbers reads `/api/usage`, which is owner-scoped,
 * `no-store`, and already the authority on them.
 *
 * `message` is safe by construction: it comes from `DENY_MESSAGES`, static strings
 * with nothing interpolated into them. No thrown exception's text reaches here.
 *
 * ## Why 429 and not 500
 *
 * A limit is an answer, not a malfunction. A client that gets 500 retries; a client
 * that gets 429 with `Retry-After` waits.
 *
 * Shared rather than written twice, because a body that leaks a counter in one of
 * the two routes and not the other is the version of this that ships.
 */
export function usageLimitResponse(err: UsageLimitError): NextResponse {
  return NextResponse.json(
    { error: err.message, reason: err.reason },
    {
      status: 429,
      headers: err.retryAfterSeconds
        ? { "Retry-After": String(err.retryAfterSeconds) }
        : undefined,
    },
  );
}
