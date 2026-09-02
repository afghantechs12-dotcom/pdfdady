import { NextResponse } from "next/server";
import { z } from "zod";
import { readStore, updateStore } from "@/data/admin";
import { requireAdmin } from "../_guard";

const schema = z.object({
  sitemapExcluded: z.array(z.string()),
  robotsDisallow: z.array(z.string()),
  defaultOgAuthor: z.string().min(1),
  defaultArticleSection: z.string().min(1),
});

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const store = await readStore();
  return NextResponse.json(store.seo);
}

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
    s.seo = parsed.data;
  });
  return NextResponse.json({ ok: true });
}
