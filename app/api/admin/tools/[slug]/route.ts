import { NextResponse } from "next/server";
import { z } from "zod";
import { readStore, updateStore } from "@/data/admin";
import {
  isCanonicalToolSlug,
  UNKNOWN_TOOL_IDENTITY_ERROR,
} from "@/lib/tools/capability";
import { requireAdmin } from "../../_guard";

const toolSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be kebab-case ASCII"),
  name: z.string().min(1),
  description: z.string().min(1),
  href: z.string().min(1).optional(),
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
  accept: z.array(z.string()),
  multiple: z.boolean(),
  plannedReason: z.string().optional(),
});

async function fullTool(roomSlug: string) {
  const tools = await (await import("@/data/admin")).getTools();
  const found = tools.find((t) => t.slug === roomSlug);
  if (!found) return null;
  return found;
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  const t = await fullTool(slug);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const store = await readStore();
  return NextResponse.json({ tool: t, override: store.tools[slug] ?? {} });
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  const parsed = toolSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const data = parsed.data;
  if (data.slug !== slug) {
    return NextResponse.json(
      { error: "Slug mismatch (URL vs body)" },
      { status: 400 },
    );
  }
  // PUT on an unknown slug is creation by another name — it wrote a brand-new
  // `s.tools[slug]` record just as POST did. Same refusal, same reason: the
  // identity is the code's, and a record the runtime cannot execute must not be
  // storable as a tool.
  if (!isCanonicalToolSlug(slug)) {
    return NextResponse.json(
      { error: UNKNOWN_TOOL_IDENTITY_ERROR, slug },
      { status: 422 },
    );
  }
  await updateStore((s) => {
    s.tools[slug] = {
      // Persist the full record so admin overrides fully replace the default.
      slug: data.slug,
      name: data.name,
      description: data.description,
      icon: data.icon,
      iconTone: data.iconTone,
      status: data.status,
      category: data.category,
      accept: data.accept,
      multiple: data.multiple,
      plannedReason: data.plannedReason,
    };
  });
  return NextResponse.json({ ok: true });
}

/**
 * Clears the stored override for a slug: "reset to default" for a canonical tool,
 * and the removal path for an orphan record (a non-canonical entry stored before
 * the write boundary above existed). Deliberately NOT slug-guarded — refusing to
 * delete an unsupported record would strand it in the store forever.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  await updateStore((s) => {
    delete s.tools[slug];
  });
  return NextResponse.json({ ok: true });
}
