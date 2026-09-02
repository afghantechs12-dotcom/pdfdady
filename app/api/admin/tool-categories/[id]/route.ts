import { NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const schema = z.object({
  label: z.string().min(1),
  tabLabel: z.string().min(1),
});

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { id } = await params;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  await updateStore((s) => {
    s.toolCategories[id] = parsed.data;
  });
  return NextResponse.json({ ok: true });
}
