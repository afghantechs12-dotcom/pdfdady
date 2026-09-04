/**
 * THE upload boundary for the private Workspace routes.
 *
 * One function, three routes, one order. It exists because the order was
 * previously per-route and drifted: all three parsed a multipart body — up to
 * 25 MiB on `attachments`, 100 MiB on the two document routes — before checking
 * whether the caller was signed in, and none of them was rate limited, while the
 * PUBLIC tool route was. An unauthenticated caller could therefore ask this
 * server to buffer and parse a body, as often as it liked, and learn only that
 * its fields were invalid.
 *
 * THE ORDER, and what each stage costs:
 *
 *   1. origin/CSRF          two header reads
 *   2. declared length      one header read; refuses before a byte is read
 *   3. media type           one header read
 *   4. session              cookie + one indexed session/user lookup, NO body
 *   5. rate limit           in-process map lookup, keyed by stage 4's identity
 *   6. authentication       the 401, once the limiter has had its say
 *   7. bounded parse        the ONLY body read, capped mid-stream
 *
 * Nothing above stage 7 touches `request.body`, which is the invariant the whole
 * file exists to hold. Organization and role authorization stay where they were —
 * AFTER the parse — because the organization is a FORM FIELD: hoisting it would
 * either pick the wrong organization for a multi-org user, or make a foreign
 * Workspace answer differently from a missing one. Stage 4 is the authorization
 * that can honestly precede the body; the rest cannot, and per-request bytes are
 * bounded by stage 7 and per-caller volume by stage 5 regardless.
 *
 * The 429 comes BEFORE the 401 on purpose. Both are cheap refusals, and an
 * unauthenticated flood has to be countable for the count to bound anything.
 * A signed-in user is charged their own bucket (stage 4 ran first), so that flood
 * cannot spend anyone else's budget.
 */

import type { NextRequest } from "next/server";

import {
  getSessionUser,
  requireSameOrigin,
  workspaceError,
  type SessionUser,
} from "@/src/application/services/workspaceHttp";

import {
  declaredLengthExceeds,
  isMultipartRequest,
  multipartFailure,
  readMultipart,
} from "./multipart";
import { checkUploadLimit } from "./uploadRateLimit";

export interface WorkspaceUploadGateOptions {
  /**
   * Ceiling for the whole body: refused when DECLARED above it, and enforced
   * again while the bytes stream in. One number for both so a lying
   * `Content-Length` buys nothing.
   */
  maxBytes: number;
  /**
   * The route's own 413 wording, kept so this refactor changes no client-visible
   * message. Every 413 the gate returns for this route uses it, whether the
   * refusal came from the declared length or from the stream.
   */
  tooLargeMessage: string;
}

export type WorkspaceUploadGateResult =
  | { form: FormData; sessionUser: SessionUser }
  | { response: Response };

/**
 * Refusals must not be cached: the next attempt's answer is a different one.
 *
 * Applied to EVERY refusal this gate returns, including the two it did not
 * build itself (the CSRF 403 and the 401), so the response matrix has one rule
 * rather than a per-status exception. `NextResponse` and the plain `Response`
 * those two return both carry mutable headers here.
 */
function refuse<T extends Response>(response: T, retryAfterSeconds?: number): T {
  response.headers.set("Cache-Control", "no-store");
  if (retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(retryAfterSeconds));
  }
  return response;
}

export async function workspaceUploadGate(
  request: NextRequest,
  options: WorkspaceUploadGateOptions,
): Promise<WorkspaceUploadGateResult> {
  const csrf = requireSameOrigin(request);
  if (csrf) return { response: refuse(csrf) };

  if (declaredLengthExceeds(request, options.maxBytes)) {
    return {
      response: refuse(
        workspaceError(request, "PAYLOAD_TOO_LARGE", options.tooLargeMessage, 413),
      ),
    };
  }

  if (!isMultipartRequest(request)) {
    return {
      response: refuse(
        workspaceError(request, "INVALID_INPUT", "Expected a multipart/form-data upload.", 415),
      ),
    };
  }

  const session = await getSessionUser(request);
  const limit = checkUploadLimit({
    request,
    userId: "user" in session ? session.user.id : null,
  });
  if (limit.limited) {
    return {
      response: refuse(
        workspaceError(
          request,
          "RATE_LIMITED",
          "Too many uploads. Please wait and try again.",
          429,
        ),
        limit.retryAfterSeconds,
      ),
    };
  }
  if ("response" in session) return { response: refuse(session.response) };

  try {
    return { form: await readMultipart(request, options.maxBytes), sessionUser: session.user };
  } catch (error) {
    const failure = multipartFailure(error);
    if (!failure) throw error;
    return {
      response: refuse(
        workspaceError(
          request,
          failure.code,
          failure.status === 413 ? options.tooLargeMessage : failure.message,
          failure.status,
        ),
      ),
    };
  }
}
