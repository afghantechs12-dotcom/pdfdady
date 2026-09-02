/**
 * MultipartUpload port — resumable, chunked uploads for large files.
 *
 * Lets the client PUT parts directly to storage (bypassing the app server's
 * memory) and complete the upload, so a 500MB PDF never buffers in Node. The
 * local adapter implements this as a simple concatenate; the R2 adapter maps it
 * to S3 multipart upload. Adapters return presigned per-part URLs (or, for the
 * local adapter, an app-internal part endpoint) so bytes go straight to storage.
 */
export interface MultipartSession {
  uploadId: string;
  key: string;
  /** Per-part presigned URLs (or local part-POST endpoints). */
  parts: { partNumber: number; url: string }[];
}

export interface CompletedPart {
  partNumber: number;
  /** ETag returned by the part upload (S3/R2) or a local checksum. */
  etag: string;
}

export interface IMultipartUpload {
  /** Begins a multipart upload for `key`, returning presigned part URLs. */
  create(key: string, contentType: string, partCount: number, partSize: number): Promise<MultipartSession>;

  /** Finalizes the upload with the client-reported parts. Returns the final key. */
  complete(session: MultipartSession, parts: CompletedPart[]): Promise<{ key: string }>;

  /** Aborts an in-progress multipart upload, dropping any uploaded parts. */
  abort(session: MultipartSession): Promise<void>;
}
