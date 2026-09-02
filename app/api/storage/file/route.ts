import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { getConfig } from "@/src/infrastructure/config/env";
import { verifyLocalUrl } from "@/src/infrastructure/storage/localSignedUrl";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Local-filesystem signed-URL serving endpoint.
 *
 * Only used when the storage provider is "local" (dev/standalone). In
 * production (R2), signed URLs point directly at R2 and never hit this route.
 * Verifies the HMAC signature + expiry from LocalSignedUrlService, then streams
 * the bytes from LocalFileStorage. The signature binds the key + verb + expiry,
 * so a URL cannot be reused for a different key or beyond its TTL.
 */
export async function GET(req: Request) {
  const cfg = getConfig();
  if (cfg.storage.provider !== "local") {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const verb = url.searchParams.get("verb");
  const expires = url.searchParams.get("expires");
  const sig = url.searchParams.get("sig");

  if (!key || !verb || !expires || !sig) {
    return new NextResponse("Bad request", { status: 400 });
  }
  if (verb !== "get") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(expires) <= nowSec) {
    return new NextResponse("Link expired", { status: 410 });
  }
  if (!verifyLocalUrl(cfg.storage.signingSecret, `${key}|${verb}|${expires}`, sig)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const storage = appContainer.resolve<IObjectStorage>(Tokens.ObjectStorage);
    const buf = await storage.get(key);
    return new NextResponse(buf, {
      headers: { "Cache-Control": "private, max-age=0, no-store" },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
