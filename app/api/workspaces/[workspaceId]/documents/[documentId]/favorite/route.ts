import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
const schema = z.object({ organizationId: z.string().min(1), revision: z.number().int().positive() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "organizationId and revision required.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const document = await workspaceServices().documents.toggleFavorite(actorResult.actor, workspaceId, documentId, parsed.data.revision);
    return NextResponse.json({ document });
  } catch (error) { return mapWorkspaceError(request, error); }
}
