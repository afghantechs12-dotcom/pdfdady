import { NextResponse } from "next/server";
import { z } from "zod";
import { removeCollectionItem, updateStore } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.string().min(1),
  period: z.string().optional(),
  description: z.string().min(1),
  features: z.array(z.string()),
  cta: z.string().min(1),
  href: z.string().min(1),
  available: z.boolean(),
  highlighted: z.boolean().optional(),
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
    s.pricing[id] = parsed.data;
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { id } = await params;
  await removeCollectionItem("pricing", id);
  return NextResponse.json({ ok: true });
}
