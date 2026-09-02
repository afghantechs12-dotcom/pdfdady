import { NextResponse } from "next/server";
import { z } from "zod";
import { readStore } from "@/data/admin";
import { isAdminPasswordSet, verifyPassword } from "@/lib/admin/passwords";
import { ADMIN_COOKIE, createSessionToken } from "@/lib/admin/session";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";

const schema = z.object({
  password: z.string().min(1),
});

// In-process fixed-window rate limit on login attempts (per client IP).
// Single-instance guard — behind multiple instances enforce at the LB too.
const loginLimiter = new RateLimiter({ windowMs: 60_000, max: 5 });

export async function POST(req: Request) {
  if (loginLimiter.hit(clientIp(req))) {
    return NextResponse.json(
      { error: "Too many login attempts. Please wait a minute and try again." },
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
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  const store = await readStore();
  // First-run gate: no password configured yet → refuse login and point the
  // operator at setup. 409 (not 401) lets the UI distinguish "wrong password"
  // from "not yet configured".
  if (!isAdminPasswordSet(store.settings.adminPasswordHash)) {
    return NextResponse.json(
      {
        error: "No admin password is configured yet. Visit /admin/setup to set one.",
        setupRequired: true,
      },
      { status: 409 },
    );
  }

  const ok = verifyPassword(parsed.data.password, store.settings.adminPasswordHash);
  if (!ok) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  return res;
}
