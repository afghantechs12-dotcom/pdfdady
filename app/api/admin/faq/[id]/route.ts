import { NextResponse } from "next/server";
import { z } from "zod";
import { removeCollectionItem, updateStore } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const faqSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, "ID must be kebab-case ASCII"),
  question: z.string().min(3),
  answer: z.string().min(10),
});

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { id } = await params;
  const parsed = faqSchema.safeParse(await req.json());
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
    s.faq[id] = parsed.data;
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { id } = await params;
  await removeCollectionItem("faq", id);
  return NextResponse.json({ ok: true });
}
