import { NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/data/admin";
import { serverToolConfig as defaults } from "@/data/serverToolConfig";
import { requireAdmin } from "../../_guard";

const selectOption = z.object({
  kind: z.literal("select"),
  name: z.string().min(1),
  label: z.string().min(1),
  default: z.string(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
    .min(1),
});

const passwordOption = z.object({
  kind: z.literal("password"),
  name: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});

const optionField = z.discriminatedUnion("kind", [selectOption, passwordOption]);

const configSchema = z.object({
  accept: z.array(z.string().min(1)).min(1),
  extensions: z.array(z.string().min(1)).min(1),
  maxSizeBytes: z.number().int().positive(),
  buttonLabel: z.string().min(1),
  processingLabel: z.string().min(1),
  uploadTitle: z.string().min(1),
  acceptHint: z.string().min(1),
  resultNote: z.string().optional(),
  showSizeComparison: z.boolean().optional(),
  options: z.array(optionField),
});

/** Update a single server tool's config. Only known server-tool slugs allowed. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  if (!(slug in defaults)) {
    return NextResponse.json({ error: "Unknown server tool" }, { status: 404 });
  }
  const parsed = configSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  await updateStore((s) => {
    s.serverTools = s.serverTools ?? {};
    s.serverTools[slug] = parsed.data;
  });
  return NextResponse.json({ ok: true });
}

/** Reset a server tool back to its code defaults by clearing the override. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const { slug } = await params;
  await updateStore((s) => {
    if (s.serverTools) delete s.serverTools[slug];
  });
  return NextResponse.json({ ok: true });
}
