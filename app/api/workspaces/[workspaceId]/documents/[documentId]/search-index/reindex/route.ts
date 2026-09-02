import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { searchService, toSearchStatusResponse } from "@/src/application/services/searchHttp";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  organizationId: z.string().min(1).max(SEARCH_LIMITS.maxIdLength),
}).strict();

/** Marks an authorized document pending for asynchronous trusted reindexing. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
): Promise<Response> {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid reindex request.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const status = await searchService().requestReindex(actorResult.actor, workspaceId, documentId);
    return NextResponse.json({ searchIndex: toSearchStatusResponse(status) }, { status: 202 });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
