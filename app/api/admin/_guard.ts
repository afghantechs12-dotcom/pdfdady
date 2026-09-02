import { NextResponse } from "next/server";
import { ADMIN_COOKIE, readAdminCookie, verifySessionToken } from "@/lib/admin/session";

/** Returns null if the request carries a valid admin session, else a 401. */
export async function requireAdmin(req: Request): Promise<NextResponse | null> {
  const token = readAdminCookie(req.headers.get("cookie"));
  if (!(await verifySessionToken(token))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export { ADMIN_COOKIE };
