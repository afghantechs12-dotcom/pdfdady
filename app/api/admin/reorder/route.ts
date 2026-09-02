import { NextResponse } from "next/server";
import { z } from "zod";
import { setOrder, type OrderableCollection } from "@/data/admin";
import { requireAdmin } from "../_guard";

const COLLECTIONS = [
  "tools",
  "blog",
  "faq",
  "features",
  "pricing",
  "useCases",
  "trust",
  "aiTools",
] as const;

const schema = z.object({
  collection: z.enum(COLLECTIONS),
  order: z.array(z.string().min(1)).min(1),
});

/** Persists an explicit display order for any orderable collection. */
export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  await setOrder(parsed.data.collection as OrderableCollection, parsed.data.order);
  return NextResponse.json({ ok: true });
}
