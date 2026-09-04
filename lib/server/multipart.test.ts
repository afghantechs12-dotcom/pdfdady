import { describe, expect, it } from "vitest";

import {
  MalformedMultipartError,
  MultipartTooLargeError,
  declaredLengthExceeds,
  isMultipartRequest,
  multipartFailure,
  readMultipart,
} from "./multipart";

const B = "----pdfdadiTest";

/** A multipart body with one file part of `size` bytes. */
function multipartBody(size: number, filename = "a.pdf"): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
    ),
    Buffer.alloc(size, 0x41),
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);
}

/**
 * A request whose body arrives in chunks, counting the bytes actually PULLED.
 *
 * The count is the whole point of S10: a bounded reader stops pulling, so a
 * 40 MiB body sent past a 1 MiB ceiling must not have 40 MiB read off the wire.
 */
function streamedRequest(
  chunks: Buffer[],
  headers: Record<string, string> = {},
): { request: Request; pulled: () => number } {
  let pulled = 0;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      pulled += chunk.byteLength;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
  const request = new Request("https://example.test/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${B}`, ...headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, pulled: () => pulled };
}

function bufferedRequest(body: Buffer, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${B}`, ...headers },
    body: new Uint8Array(body),
  });
}

describe("S9/S10/S17 — the bounded multipart reader", () => {
  it("parses a body inside the ceiling", async () => {
    const form = await readMultipart(bufferedRequest(multipartBody(1000)), 64 * 1024);
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).size).toBe(1000);
  });

  it("refuses a body over the ceiling", async () => {
    await expect(readMultipart(bufferedRequest(multipartBody(200_000)), 64 * 1024)).rejects.toBeInstanceOf(
      MultipartTooLargeError,
    );
  });

  it("refuses an understated Content-Length that streams more than it declared", async () => {
    // The declared length says 10 bytes. The stream delivers 4 MiB. A ceiling
    // that trusted the header would have parsed all of it.
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(1024 * 1024, 0x41));
    const { request, pulled } = streamedRequest(chunks, { "content-length": "10" });
    expect(declaredLengthExceeds(request, 64 * 1024)).toBe(false);
    await expect(readMultipart(request, 64 * 1024)).rejects.toBeInstanceOf(MultipartTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("refuses a chunked body with no declared length at all, without reading it all", async () => {
    const chunks = Array.from({ length: 40 }, () => Buffer.alloc(1024 * 1024, 0x41));
    const { request, pulled } = streamedRequest(chunks, { "transfer-encoding": "chunked" });
    expect(request.headers.get("content-length")).toBeNull();
    expect(declaredLengthExceeds(request, 1024 * 1024)).toBe(false);
    await expect(readMultipart(request, 1024 * 1024)).rejects.toBeInstanceOf(MultipartTooLargeError);
    // The ceiling, plus the chunk that crossed it, plus the one more the source
    // stream's own queue had already read ahead — 3 MiB, not 40 MiB. The bound is
    // stated in chunks rather than bytes because that is what it actually is.
    expect(pulled()).toBeLessThanOrEqual(1024 * 1024 + 2 * 1024 * 1024);
  });

  it("treats a negative or unparseable declared length as no declared length, and still bounds the body", async () => {
    for (const value of ["-1", "not-a-number", ""]) {
      const { request } = streamedRequest([Buffer.alloc(512 * 1024, 0x41)], {
        "content-length": value,
      });
      expect(declaredLengthExceeds(request, 64 * 1024)).toBe(false);
      await expect(readMultipart(request, 64 * 1024)).rejects.toBeInstanceOf(MultipartTooLargeError);
    }
  });

  it("refuses a body whose declared length is over the ceiling without reading it", async () => {
    const { request, pulled } = streamedRequest([Buffer.alloc(4096)], {
      "content-length": String(10 * 1024 * 1024),
    });
    expect(declaredLengthExceeds(request, 1024 * 1024)).toBe(true);
    expect(pulled()).toBe(0);
  });

  it("reports an unparseable body as malformed, never as a generic failure", async () => {
    // A filename carrying a raw `"` — the body that used to reach a route's
    // generic catch as an unlogged 500.
    const request = bufferedRequest(multipartBody(16, 'ev"il.pdf'));
    await expect(readMultipart(request, 64 * 1024)).rejects.toBeInstanceOf(MalformedMultipartError);
  });

  it("reports a body that is not multipart at all as malformed", async () => {
    const request = new Request("https://example.test/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=" + B },
      body: "not multipart",
    });
    expect(isMultipartRequest(request)).toBe(true);
    await expect(readMultipart(request, 64 * 1024)).rejects.toBeInstanceOf(MalformedMultipartError);
  });

  it("recognises a non-multipart content type", () => {
    const json = new Request("https://example.test/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(isMultipartRequest(json)).toBe(false);
  });

  it("maps its two errors onto one taxonomy and nothing else onto it", () => {
    expect(multipartFailure(new MultipartTooLargeError())).toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(multipartFailure(new MalformedMultipartError())).toMatchObject({
      status: 400,
      code: "MALFORMED_MULTIPART",
      message: "Malformed multipart body.",
    });
    expect(multipartFailure(new Error("something else"))).toBeNull();
  });
});
