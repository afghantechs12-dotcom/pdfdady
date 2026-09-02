import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type {
  IMultipartUpload,
  MultipartSession,
  CompletedPart,
} from "@/src/application/ports/storage/MultipartUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Local-only multipart part receiver. R2 clients PUT parts directly to
 * presigned R2 URLs, so this is only implemented by LocalMultipartUpload.
 */
interface LocalReceiver {
  receivePart(uploadId: string, partNumber: number, data: Buffer): Promise<{ etag: string }>;
}

async function resolveMultipart(): Promise<IMultipartUpload> {
  return appContainer.resolve<IMultipartUpload>(Tokens.MultipartUpload);
}

/** PUT /api/storage/multipart/{uploadId}/{partNumber} — upload one part (local). */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ segments: string[] }> },
) {
  const segs = (await params).segments;
  if (segs.length !== 2) return new NextResponse("Not found", { status: 404 });
  const uploadId = segs[0];
  const partNumber = Number(segs[1]);
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return new NextResponse("Bad part number", { status: 400 });
  }
  const multipart = await resolveMultipart();
  if (typeof (multipart as Partial<LocalReceiver>).receivePart !== "function") {
    // R2: parts go directly to presigned URLs, not through the app.
    return new NextResponse("Not found", { status: 404 });
  }
  const data = Buffer.from(await req.arrayBuffer());
  const { etag } = await (multipart as unknown as LocalReceiver).receivePart(
    uploadId,
    partNumber,
    data,
  );
  return NextResponse.json({ etag }, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/storage/multipart/{uploadId}/complete — finalize the upload. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ segments: string[] }> },
) {
  const segs = (await params).segments;
  if (segs.length !== 2 || segs[1] !== "complete") {
    return new NextResponse("Not found", { status: 404 });
  }
  const uploadId = segs[0];
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const key = body.key;
  const parts = body.parts;
  if (typeof key !== "string" || !Array.isArray(parts)) {
    return new NextResponse("Bad request", { status: 400 });
  }
  const multipart = await resolveMultipart();
  const session: MultipartSession = { uploadId, key, parts: [] };
  try {
    const res = await multipart.complete(session, parts as CompletedPart[]);
    return NextResponse.json(res, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return new NextResponse("Complete failed", { status: 500 });
  }
}

/** DELETE /api/storage/multipart/{uploadId} — abort the upload. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ segments: string[] }> },
) {
  const segs = (await params).segments;
  if (segs.length !== 1) return new NextResponse("Not found", { status: 404 });
  const uploadId = segs[0];
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const key = body.key;
  if (typeof key !== "string") return new NextResponse("Bad request", { status: 400 });
  const multipart = await resolveMultipart();
  try {
    await multipart.abort({ uploadId, key, parts: [] });
    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse("Abort failed", { status: 500 });
  }
}
