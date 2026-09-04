/**
 * The ONE place a multipart body is read, and the one authority on what a
 * failure to read it means.
 *
 * Every `request.formData()` in shipped code lives in this file. That is not
 * tidiness: five call sites each wrote their own guard, and the guards disagreed
 * — the same unparseable body answered `422 "A multipart upload is required."`
 * on one route and `400 "Malformed multipart body."` on another, and a body
 * larger than the declared ceiling was refused only when the client was honest
 * enough to declare its size. A single reader is what makes "no route parses
 * more bytes than its ceiling" a property of the system rather than of whichever
 * route was edited last.
 *
 * WHY THE STREAM IS COUNTED RATHER THAN THE HEADER TRUSTED. `Content-Length` is
 * a claim. HTTP/1.1 will not deliver more bytes than an understated length
 * declares, but `Transfer-Encoding: chunked` declares no length at all, and a
 * chunked body is the vector a header check cannot see. The counting stream
 * below is what bounds THAT request: bytes are refused as they arrive, so the
 * peak allocation is one chunk over the ceiling rather than the whole body.
 */
import { NextResponse } from "next/server";

/** The body exceeded its byte ceiling while being read. */
export class MultipartTooLargeError extends Error {
  constructor(message = "Upload too large.") {
    super(message);
    this.name = "MultipartTooLargeError";
  }
}

/** The body could not be parsed as `multipart/form-data`. */
export class MalformedMultipartError extends Error {
  constructor(message = "Malformed multipart body.") {
    super(message);
    this.name = "MalformedMultipartError";
  }
}

/** True when the request declares a `multipart/form-data` content type. */
export function isMultipartRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("multipart/form-data");
}

/**
 * True when the DECLARED length is already over the ceiling.
 *
 * Kept as the cheap first answer — it costs a header read and refuses the
 * request before a byte is transferred — but it is never the whole ceiling: a
 * request with no `Content-Length` at all takes this branch as "fine", and only
 * {@link readMultipart} bounds it.
 */
export function declaredLengthExceeds(request: Request, maxBytes: number): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * Reads the request as multipart form data, refusing more than `maxBytes` of
 * body regardless of what the request declared.
 *
 * Throws {@link MultipartTooLargeError} or {@link MalformedMultipartError} and
 * nothing else — an unreadable body is the CLIENT's error, and a reader that let
 * undici's `TypeError` escape is how one became an unlogged HTTP 500.
 */
export async function readMultipart(request: Request, maxBytes: number): Promise<FormData> {
  const body = request.body;
  // No stream to count (a body already buffered by the runtime, or none at all).
  // The declared-length check upstream is the only bound available here, which is
  // why callers must still make it.
  if (!body) return await parseOrThrow(request);

  let seen = 0;
  const reader = body.getReader();
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBytes) {
        // Error the stream INSTEAD of enqueueing: the parser never sees the
        // chunk that crossed the line, so the peak held is the ceiling plus one
        // chunk rather than the whole body.
        await reader.cancel().catch(() => {});
        controller.error(new MultipartTooLargeError());
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return await parseOrThrow(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: counted,
      // Required by Node for a stream body; the request is send-then-receive.
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
}

/** Parses, translating every failure into this module's two error types. */
async function parseOrThrow(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch (error) {
    // undici reports a stream error by rejecting with its own TypeError and
    // hanging the real reason off `cause`, so the ceiling has to be recovered
    // from the chain rather than the top-level error.
    for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth += 1) {
      if (cursor instanceof MultipartTooLargeError) throw cursor;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    throw new MalformedMultipartError();
  }
}

/**
 * The canonical status and code for a multipart boundary failure, or null when
 * the error is not one of ours.
 *
 * ONE taxonomy, two envelopes: the Workspace routes answer
 * `{error:{code,message,requestId}}` and the tool routes answer `{error}`, so
 * each formats this decision rather than making its own.
 */
export function multipartFailure(
  error: unknown,
): { status: number; code: string; message: string } | null {
  if (error instanceof MultipartTooLargeError) {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: error.message };
  }
  if (error instanceof MalformedMultipartError) {
    return { status: 400, code: "MALFORMED_MULTIPART", message: error.message };
  }
  return null;
}

/** {@link multipartFailure} in the tool routes' flat `{error}` envelope. */
export function multipartToolResponse(error: unknown): NextResponse | null {
  const failure = multipartFailure(error);
  if (!failure) return null;
  return NextResponse.json(
    { error: failure.message },
    { status: failure.status, headers: { "Cache-Control": "no-store" } },
  );
}
