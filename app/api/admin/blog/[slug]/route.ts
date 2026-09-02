import { NextResponse } from "next/server";
import { z } from "zod";
import { removeCollectionItem, updateStore } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const blockSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("heading"),
      level: z.union([z.literal(2), z.literal(3)]),
      id: z.string().min(1),
      text: z.string().min(1),
    }),
    z.object({ type: z.literal("paragraph"), text: z.string().min(1) }),
    z.object({
      type: z.literal("list"),
      ordered: z.boolean().optional(),
      items: z.array(z.string()),
    }),
    z.object({
      type: z.literal("callout"),
      variant: z.enum(["info", "tip", "warning"]),
      text: z.string().min(1),
    }),
    z.object({
      type: z.literal("quote"),
      text: z.string().min(1),
      cite: z.string().optional(),
    }),
    z.object({
      type: z.literal("toolCta"),
      toolSlug: z.string().min(1),
      label: z.string().optional(),
    }),
  ]),
);

const howToSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    steps: z.array(
      z.object({
        name: z.string().min(1),
        text: z.string().min(1),
      }),
    ),
  })
  .optional();

const faqItemSchema = z.object({
  question: z.string().min(3),
  answer: z.string().min(10),
});

const authorSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  bio: z.string().min(1),
});

const postSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be kebab-case ASCII"),
  title: z.string().min(3),
  excerpt: z.string().min(10),
  category: z.string().min(1),
  tags: z.array(z.string()).min(1),
  author: authorSchema,
  datePublished: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  dateUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  readTime: z.string().min(1),
  featured: z.boolean().optional(),
  heroIcon: z.string().min(1),
  heroTone: z.enum(["purple", "blue", "green", "orange", "pink", "teal", "red"]),
  relatedToolSlug: z.string().optional(),
  body: z.array(blockSchema).min(1),
  howTo: howToSchema,
  faq: z.array(faqItemSchema).optional(),
  relatedSlugs: z.array(z.string()).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  const { getBlogPosts } = await import("@/data/admin");
  const posts = await getBlogPosts();
  const found = posts.find((p) => p.slug === slug);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ post: found });
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  const parsed = postSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  if (parsed.data.slug !== slug) {
    return NextResponse.json({ error: "Slug mismatch" }, { status: 400 });
  }
  await updateStore((s) => {
    s.blog.posts[slug] = parsed.data as Record<string, unknown>;
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  await removeCollectionItem("blog", slug);
  return NextResponse.json({ ok: true });
}
