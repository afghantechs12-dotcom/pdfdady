import { NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/data/admin";
import {
  isCanonicalToolSlug,
  UNKNOWN_TOOL_IDENTITY_ERROR,
} from "@/lib/tools/capability";
import { requireAdmin } from "../_guard";

const toolSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be kebab-case ASCII"),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  iconTone: z.enum(["purple", "blue", "green", "orange", "pink", "teal", "red"]),
  status: z.enum([
    "functional-client",
    "functional-server",
    "planned",
    "coming-soon-ai",
  ]),
  category: z.enum([
    "organize",
    "optimize",
    "convert-to",
    "convert-from",
    "edit",
    "security",
    "ai",
  ]),
  accept: z.array(z.string()).min(1),
  multiple: z.boolean(),
  plannedReason: z.string().optional(),
});

/**
 * Editorial content for an existing tool. NOT a way to create one.
 *
 * The route used to write `s.tools[slug]` for any kebab-case slug, which is how a
 * CMS record with no implementation reached the catalog and the counts. It is kept
 * (rather than deleted) so a stale admin client gets the reason rather than a bare
 * 405, and it now answers the only honest thing it can for an unknown identity:
 * refused, with nothing written. A tool exists because code implements it.
 *
 * The status quo it serves: an override for a canonical slug, exactly what PUT
 * does — so an admin client that still POSTs an edit keeps working.
 */
export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const parsed = toolSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  if (!isCanonicalToolSlug(parsed.data.slug)) {
    return NextResponse.json(
      { error: UNKNOWN_TOOL_IDENTITY_ERROR, slug: parsed.data.slug },
      { status: 422 },
    );
  }
  await updateStore((s) => {
    s.tools[parsed.data.slug] = parsed.data;
  });
  return NextResponse.json({ ok: true });
}
