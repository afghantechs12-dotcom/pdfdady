import { Readable } from "node:stream";

/**
 * Web ↔ Node ReadableStream bridge.
 *
 * The storage + job-handler code types streams as the DOM-lib
 * `ReadableStream<Uint8Array>` (the Web standard the ports speak), while Node's
 * `Readable.fromWeb` / `Readable.toWeb` helpers expect the `node:stream/web`
 * declaration. At runtime they are the SAME global (Node exposes the Web Streams
 * API), so these helpers only bridge the TS lib mismatch — they are not real
 * type conversions. Centralized here so the cast lives in one place instead of
 * being copied across every storage adapter + the job handler.
 *
 * Returns/accepts the concrete `Readable` class (not the loose
 * `NodeJS.ReadableStream` interface) so callers can use `.destroy()` etc.
 */

type NodeWebReadableStream = Parameters<typeof Readable.fromWeb>[0];

/** Convert a Web ReadableStream to a Node Readable. */
export function webStreamToNodeReadable(
  s: ReadableStream<Uint8Array>,
): Readable {
  return Readable.fromWeb(s as unknown as NodeWebReadableStream);
}

/** Convert a Node Readable to a Web ReadableStream<Uint8Array>. */
export function nodeReadableToWebStream(r: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(r) as ReadableStream<Uint8Array>;
}
