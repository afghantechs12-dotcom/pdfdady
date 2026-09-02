import { NextResponse } from "next/server";
import { z } from "zod";
import { removeCollectionItem, updateStore } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
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
  if (parsed.data.id !== id) {
    return NextResponse.json({ error: "ID mismatch" }, { status: 400 });
  }
  await updateStore((s) => {
    s.aiTools[id] = parsed.data;
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { id } = await params;
  await removeCollectionItem("aiTools", id);
  return NextResponse.json({ ok: true });
}
