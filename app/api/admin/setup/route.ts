import { NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/data/admin";
import { hashPassword, isAdminPasswordSet } from "@/lib/admin/passwords";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
});

// Rate-limit setup attempts per IP. There is nothing to brute-force before a
// password exists, but this bounds spam/abuse of the open endpoint. The
// actual race-safety is handled inside updateStore (mutex + check-and-set).
const setupLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });

/**
 * First-run admin setup. Sets the initial admin password, but ONLY if no
 * password is configured yet. No session is required (this is the credential
 * bootstrap), but the check-and-set is guarded by the store mutex so two
 * concurrent first-run requests can't both set a password — the first wins,
 * the second gets 409.
 */
export async function POST(req: Request) {
  if (setupLimiter.hit(clientIp(req))) {
    return NextResponse.json(
      { error: "Too many setup attempts. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  // Atomically check-and-set under the store mutex. The mutator runs inside
  // updateStore's serialized read-modify-write, so this is race-safe within a
  // process: the first request to reach here sets the hash; a concurrent one
  // observes it already set and is refused.
  let alreadySet = false;
  await updateStore((s) => {
    if (isAdminPasswordSet(s.settings.adminPasswordHash)) {
      alreadySet = true;
      return;
    }
    s.settings.adminPasswordHash = hashPassword(parsed.data.password);
  });

  if (alreadySet) {
    return NextResponse.json(
      { error: "An admin password is already configured. Sign in at /admin/login." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
