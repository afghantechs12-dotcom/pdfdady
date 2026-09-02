import { NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const schema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  bio: z.string().min(1),
});

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  await updateStore((s) => {
    s.blog.author = parsed.data;
  });
  return NextResponse.json({ ok: true });
}
