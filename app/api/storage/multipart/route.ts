import { NextResponse } from "next/server";
import { z } from "zod";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IMultipartUpload } from "@/src/application/ports/storage/MultipartUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  key: z.string().min(1),
  contentType: z.string().default("application/octet-stream"),
  partCount: z.number().int().min(1).max(10_000),
  partSize: z.number().int().positive(),
});

/** Begins a multipart upload; returns the uploadId + per-part URLs. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  try {
    const multipart = appContainer.resolve<IMultipartUpload>(Tokens.MultipartUpload);
    const session = await multipart.create(
      parsed.data.key,
      parsed.data.contentType,
      parsed.data.partCount,
      parsed.data.partSize,
    );
    return NextResponse.json(session, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Failed to start upload" }, { status: 500 });
  }
}
