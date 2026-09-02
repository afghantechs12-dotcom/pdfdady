import type {
  ISignedUrlService,
  SignedUrlVerb,
} from "@/src/application/ports/storage/SignedUrlService";
import { signLocalUrl } from "./localSignedUrl";

/**
 * Local-filesystem ISignedUrlService adapter (dev). Produces HMAC-signed,
 * time-limited URLs of the form `{baseUrl}/api/storage/file?key=...&verb=...&
 * expires=...&sig=...`; the serving route verifies `sig` + `expires` before
 * streaming bytes from LocalFileStorage. Mirrors the R2 presigned-URL contract.
 */
export class LocalSignedUrlService implements ISignedUrlService {
  constructor(
    private readonly secret: string,
    private readonly baseUrl: string,
  ) {}

  async signedUrl(
    key: string,
    verb: SignedUrlVerb,
    ttlSeconds = 900,
  ): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${key}|${verb}|${expires}`;
    const sig = signLocalUrl(this.secret, payload);
    const u = new URL("/api/storage/file", this.baseUrl);
    u.searchParams.set("key", key);
    u.searchParams.set("verb", verb);
    u.searchParams.set("expires", String(expires));
    u.searchParams.set("sig", sig);
    return u.toString();
  }
}
