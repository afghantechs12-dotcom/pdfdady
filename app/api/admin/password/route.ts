import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword, readStore, updateStore, verifyPassword } from "@/data/admin";
import { requireAdmin } from "../_guard";

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

export async function POST(req: Request) {
  // Re-check the session here so the API can't be reached with a forged cookie.
  const guard = await requireAdmin(req);
  if (guard) return guard;
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
  // The current password must be correct before we allow a change — a valid
  // session alone is not enough to rotate the credential.
  const store = await readStore();
  if (!verifyPassword(parsed.data.currentPassword, store.settings.adminPasswordHash)) {
    return NextResponse.json(
      { error: "Current password is incorrect." },
      { status: 401 },
    );
  }
  await updateStore((s) => {
    s.settings.adminPasswordHash = hashPassword(parsed.data.newPassword);
  });
  return NextResponse.json({ ok: true });
}
