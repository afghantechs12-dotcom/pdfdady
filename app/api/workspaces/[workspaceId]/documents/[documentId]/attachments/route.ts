import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService, toAttachmentResponse } from "@/src/application/services/metadataHttp";
import {
  METADATA_LIMITS as L,
  isMetadataOrigin,
} from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uploadFieldsSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  name: z.string().max(L.maxAttachmentNameLength * 2).optional(),
  description: z.string().max(L.maxDescriptionLength * 2).optional(),
});

/** A document's attachment catalogue. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const { workspaceId, documentId } = await params;
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!organizationId || organizationId.length > L.maxIdLength) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  const rawOrigin = request.nextUrl.searchParams.get("origin");
  if (rawOrigin !== null && !isMetadataOrigin(rawOrigin)) {
    return workspaceError(request, "INVALID_INPUT", "Unknown attachment origin.", 422);
  }

  try {
    const attachments = await metadataService().listAttachments(
      actorResult.actor,
      workspaceId,
      documentId,
      { origin: rawOrigin === null ? undefined : rawOrigin, limit: L.maxAttachmentsPerDocument },
    );
    return NextResponse.json({ attachments: attachments.map(toAttachmentResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * Uploads an attachment as bounded multipart form data.
 *
 * Multipart rather than base64-in-JSON: a base64 body inflates the bytes by a
 * third, has to be fully buffered to be parsed, and gives the request no
 * declared length to check before reading it. The declared content length is
 * refused above the limit before any bytes are read, and the actual byte count
 * is checked again afterwards — a declared length is a claim, not a fact.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;

  const declared = Number(request.headers.get("content-length") ?? "0");
  // A little headroom over the payload cap for the multipart envelope itself.
  if (Number.isFinite(declared) && declared > L.maxAttachmentBytes + 64 * 1024) {
    return workspaceError(request, "PAYLOAD_TOO_LARGE", "This attachment is too large.", 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return workspaceError(request, "INVALID_INPUT", "A multipart upload is required.", 422);
  }

  const parsed = uploadFieldsSchema.safeParse({
    organizationId: form.get("organizationId") ?? undefined,
    name: form.get("name") ?? undefined,
    description: form.get("description") ?? undefined,
  });
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid attachment fields.", 422);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return workspaceError(request, "INVALID_INPUT", "An attachment file is required.", 422);
  }
  if (file.size > L.maxAttachmentBytes) {
    return workspaceError(request, "PAYLOAD_TOO_LARGE", "This attachment is too large.", 413);
  }

  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const data = Buffer.from(await file.arrayBuffer());
    if (data.length > L.maxAttachmentBytes) {
      return workspaceError(request, "PAYLOAD_TOO_LARGE", "This attachment is too large.", 413);
    }
    const attachment = await metadataService().createAttachment(
      actorResult.actor,
      workspaceId,
      documentId,
      {
        // The client's declared name is preferred only when it sent one; the
        // browser-supplied filename is the fallback. Both are validated in the
        // domain, which is where path separators and control characters die.
        name: parsed.data.name ?? file.name,
        description: parsed.data.description,
        mimeType: file.type || "application/octet-stream",
        data,
      },
    );
    return NextResponse.json({ attachment: toAttachmentResponse(attachment) }, { status: 201 });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
