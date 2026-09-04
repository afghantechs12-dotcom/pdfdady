import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { workspaceUploadGate } from "@/lib/server/workspaceUploadGate";
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
 * declared length to check before reading it.
 *
 * Everything ahead of the parse — CSRF, the ceiling, the media type, the session,
 * the rate limit — is {@link workspaceUploadGate}, which is shared with the two
 * document upload routes and is the only thing that reads this body. The declared
 * length is a claim, so the gate caps the stream at the same ceiling and the real
 * byte count is checked again below.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const gate = await workspaceUploadGate(request, {
    // A little headroom over the payload cap for the multipart envelope itself.
    maxBytes: L.maxAttachmentBytes + 64 * 1024,
    tooLargeMessage: "This attachment is too large.",
  });
  if ("response" in gate) return gate.response;
  const form = gate.form;
  const { workspaceId, documentId } = await params;

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

  const actorResult = await getWorkspaceActor(
    request,
    parsed.data.organizationId,
    gate.sessionUser,
  );
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
