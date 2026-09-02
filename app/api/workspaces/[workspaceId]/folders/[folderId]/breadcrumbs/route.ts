import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceActor, mapWorkspaceError, workspaceServices } from "@/src/application/services/workspaceHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; folderId: string }> }) {
  const { workspaceId, folderId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const breadcrumbs = await workspaceServices().folders.breadcrumbs(actorResult.actor, workspaceId, folderId);
    return NextResponse.json({ breadcrumbs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return mapWorkspaceError(request, error); }
}
