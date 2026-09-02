import { NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/data/admin";
import { requireAdmin } from "../../_guard";

const paraSchema = z.object({
  type: z.literal("paragraph"),
  text: z.string().min(1),
});
const headingSchema = z.object({
  type: z.literal("heading"),
  level: z.union([z.literal(2), z.literal(3)]),
  id: z.string().min(1),
  text: z.string().min(1),
});
const listSchema = z.object({
  type: z.literal("list"),
  ordered: z.boolean().optional(),
  items: z.array(z.string()),
});
const calloutSchema = z.object({
  type: z.literal("callout"),
  variant: z.enum(["info", "tip", "warning"]),
  text: z.string().min(1),
});
const quoteSchema = z.object({
  type: z.literal("quote"),
  text: z.string().min(1),
  cite: z.string().optional(),
});

const blockSchema = z.discriminatedUnion("type", [
  paraSchema,
  headingSchema,
  listSchema,
  calloutSchema,
  quoteSchema,
]);

const pageSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  blocks: z.array(blockSchema),
});

const VALID_KEYS = [
  "about",
  "contact",
  "privacy",
  "terms",
  "pricing",
  "serverStatus",
] as const;

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { key } = await params;
  if (!VALID_KEYS.includes(key as (typeof VALID_KEYS)[number])) {
    return NextResponse.json({ error: "Unknown page key" }, { status: 400 });
  }
  const parsed = pageSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  await updateStore((s) => {
    (s.pages as Record<string, unknown>)[key] = parsed.data;
  });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { key } = await params;
  const { readStore } = await import("@/data/admin");
  const s = await readStore();
  return NextResponse.json((s.pages as Record<string, unknown>)[key] ?? null);
}
