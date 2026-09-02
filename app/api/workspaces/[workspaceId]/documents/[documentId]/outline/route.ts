import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { metadataService, toOutlineItemResponse } from "@/src/application/services/metadataHttp";
import {
  METADATA_LIMITS as L,
  isMetadataOrigin,
  type OutlineNode,
} from "@/src/domain/entities/DocumentMetadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  title: z.string().max(L.maxTitleLength * 2),
  pageNumber: z.number(),
  parentId: z.string().max(L.maxIdLength).nullish(),
});

/** A document's outline, flat or assembled into a tree. */
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
    return workspaceError(request, "INVALID_INPUT", "Unknown outline origin.", 422);
  }
  const origin = rawOrigin === null ? undefined : rawOrigin;
  const wantsTree = request.nextUrl.searchParams.get("shape") === "tree";

  try {
    const service = metadataService();
    if (wantsTree) {
      const tree = await service.getOutlineTree(actorResult.actor, workspaceId, documentId, {
        origin,
      });
      return NextResponse.json({ outline: serializeTree(tree) });
    }
    const items = await service.listOutline(actorResult.actor, workspaceId, documentId, {
      origin,
      limit: L.maxOutlineItems,
    });
    return NextResponse.json({ outline: items.map(toOutlineItemResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Serializes a node tree; the domain's depth cap bounds the recursion. */
function serializeTree(nodes: OutlineNode[]): unknown[] {
  return nodes.map((node) => ({
    ...toOutlineItemResponse(node),
    children: serializeTree(node.children),
  }));
}

/** Creates a Workspace outline item. Embedded outlines are read-only. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid outline item.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    // No depth is accepted from the client: depth is derived from the validated
    // parent relationship, or a caller could place an item anywhere in the tree.
    const item = await metadataService().createOutlineItem(
      actorResult.actor,
      workspaceId,
      documentId,
      {
        title: parsed.data.title,
        pageNumber: parsed.data.pageNumber,
        parentId: parsed.data.parentId ?? null,
      },
    );
    return NextResponse.json({ outlineItem: toOutlineItemResponse(item) }, { status: 201 });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
