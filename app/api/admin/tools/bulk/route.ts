import { NextResponse } from "next/server";
import { z } from "zod";
import { setOrder } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const reorderSchema = z.object({
  /** Ordered array of slugs reflecting the desired order for the tools grid. */
  order: z.array(z.string().min(1)).min(1),
});

/**
 * Bulk reorder tools. Persists the given slug order into the store; `getTools`
 * applies it to the catalog and homepage. Kept as a thin alias over the shared
 * reorder helper so the existing Tools UI keeps working.
 */
export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const parsed = reorderSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  await setOrder("tools", parsed.data.order);
  return NextResponse.json({ ok: true });
}
