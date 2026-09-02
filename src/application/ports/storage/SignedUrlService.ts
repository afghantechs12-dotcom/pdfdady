/**
 * SignedUrlService port — time-limited, scoped URLs for upload/download.
 *
 * Adapters: R2/S3 presigning (prod) and an HMAC-signed local download route
 * (dev). The application requests a URL for a storage `key`; the adapter
 * enforces that the URL only works for `ttlSeconds` and (for private objects)
 * only grants the requested verb. This replaces the M1 "read the whole output
 * into memory and return it" pattern — responses become a redirect/302 to a
 * signed URL, so the app server never buffers file bodies.
 */
export type SignedUrlVerb = "get" | "put";

export interface ISignedUrlService {
  signedUrl(key: string, verb: SignedUrlVerb, ttlSeconds?: number): Promise<string>;
}
