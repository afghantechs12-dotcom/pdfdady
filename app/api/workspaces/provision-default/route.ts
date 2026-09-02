import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

const schema = z.object({ organizationId: z.string().min(1) });
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Organization is required.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const workspace = await workspaceServices().workspaces.provisionDefault({ userId: actorResult.actor.userId, organizationId: actorResult.actor.organizationId, role: actorResult.actor.organizationRole });
    return NextResponse.json({ workspace });
  } catch (error) { return mapWorkspaceError(request, error); }
}
