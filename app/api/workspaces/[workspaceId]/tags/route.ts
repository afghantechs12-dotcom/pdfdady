import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import { tagService, toTagResponse } from "@/src/application/services/tagHttp";
import { TAG_LIMITS as L } from "@/src/domain/entities/Tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().min(1).max(L.maxNameLength),
  color: z.string().max(L.maxColorLength).nullish(),
});

/** The Workspace's tags, ordered by normalized name. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const actorResult = await getWorkspaceActor(
    request,
    request.nextUrl.searchParams.get("organizationId") ?? undefined,
  );
  if ("response" in actorResult) return actorResult.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? L.defaultListLimit : Number(rawLimit);
  if (rawLimit !== null && !Number.isFinite(limit)) {
    return workspaceError(request, "INVALID_INPUT", "limit must be a number.", 422);
  }

  try {
    const tags = await tagService().listTags(actorResult.actor, workspaceId, limit);
    return NextResponse.json({ tags: tags.map(toTagResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Creates a tag. The normalized name is unique within the Workspace. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid tag input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const tag = await tagService().createTag(actorResult.actor, workspaceId, {
      name: parsed.data.name,
      color: parsed.data.color ?? null,
    });
    return NextResponse.json({ tag: toTagResponse(tag) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
