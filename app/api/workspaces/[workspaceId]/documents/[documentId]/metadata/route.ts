import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService, toMetadataResponse } from "@/src/application/services/metadataHttp";
import { METADATA_LIMITS as L } from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A bounded field map. Values are strings only, and the count and length are
 * capped here as well as in the domain: an unbounded body is a denial-of-service
 * vector regardless of what the domain would later reject.
 */
const fieldsSchema = z.record(z.string().max(L.maxIdLength), z.string().max(L.maxValueLength));

const saveSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  fields: fieldsSchema,
  /** Present for a compare-and-swap replace, absent for a plain save. */
  expectedRevision: z.number().int().min(1).optional(),
});

/** A document's Workspace-owned properties. */
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

  try {
    const metadata = await metadataService().getDocumentMetadata(
      actorResult.actor,
      workspaceId,
      documentId,
    );
    return NextResponse.json({ metadata: metadata ? toMetadataResponse(metadata) : null });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/**
 * Saves the Workspace-owned properties.
 *
 * A full replace, not a merge: the panel submits the whole form, and a merge
 * would make clearing a field impossible to express. Supplying
 * `expectedRevision` makes it a compare-and-swap, which is what a panel that
 * read a revision should send.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid document properties.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const service = metadataService();
    const saved =
      parsed.data.expectedRevision === undefined
        ? await service.setDocumentMetadata(
            actorResult.actor,
            workspaceId,
            documentId,
            parsed.data.fields,
          )
        : await service.replaceDocumentMetadata(
            actorResult.actor,
            workspaceId,
            documentId,
            parsed.data.expectedRevision,
            parsed.data.fields,
          );
    return NextResponse.json({ metadata: toMetadataResponse(saved) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
