import { NextResponse } from "next/server";
import { z } from "zod";
import { readStore, updateStore } from "@/data/admin";
import { requireAdmin } from "../_guard";

const schema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  logoUrl: z.string().min(1),
  ogImageUrl: z.string().min(1),
  twitter: z.string().min(1),
  locale: z.string().min(1),
  description: z.string().min(1),
  defaultTitle: z.string().min(1),
  titleTemplate: z.string().min(1),
  social: z.object({
    twitterUrl: z.string().url(),
    githubUrl: z.string().url(),
  }),
  footerTagline: z.string().min(1),
  footerCardTitle: z.string().min(1),
  footerCardSubtitle: z.string().min(1),
  trustBullets: z.array(z.string()).min(1),
});

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const store = await readStore();
  return NextResponse.json(store.site);
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
    s.site = parsed.data;
  });
  return NextResponse.json({ ok: true });
}
