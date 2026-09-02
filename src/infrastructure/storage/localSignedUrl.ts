import crypto from "node:crypto";

/**
 * HMAC-SHA256 signing for local (dev) storage URLs. The production path uses
 * R2/S3 presigning; this mirrors the contract for the local filesystem adapter
 * so the application can't tell the difference. The serving route
 * (`/api/storage/file`) verifies the signature + expiry before streaming bytes.
 */
export function signLocalUrl(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyLocalUrl(
  secret: string,
  payload: string,
  sig: string,
): boolean {
  const expected = signLocalUrl(secret, payload);
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}
