import { NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/data/admin";
import { requireAdmin } from "../_guard";

const linkSchema = z.object({
  label: z.string().min(1),
  href: z.string().min(1),
  hasDropdown: z.boolean().optional(),
});

const footerColSchema = z.object({
  title: z.string().min(1),
  links: z.array(z.object({ label: z.string().min(1), href: z.string().min(1) })),
});

const schema = z.object({
  links: z.array(linkSchema).min(1),
  footerColumns: z.array(footerColSchema).min(1),
});

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { getNavLinks, getFooterColumns } = await import("@/data/admin");
  const [links, footerColumns] = await Promise.all([getNavLinks(), getFooterColumns()]);
  return NextResponse.json({ links, footerColumns });
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
    s.nav = parsed.data;
  });
  return NextResponse.json({ ok: true });
}
