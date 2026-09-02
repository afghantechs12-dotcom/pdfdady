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

const updateSchema = z.object({
  organizationId: z.string().min(1),
  expectedRevision: z.number().int().min(1),
  name: z.string().min(1).max(L.maxNameLength).optional(),
  color: z.string().max(L.maxColorLength).nullish(),
});

const deleteSchema = z.object({
  organizationId: z.string().min(1),
});

/** Renames or recolours a tag, compare-and-swapping on its revision. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; tagId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, tagId } = await params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid tag input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const tag = await tagService().updateTag(
      actorResult.actor,
      workspaceId,
      tagId,
      parsed.data.expectedRevision,
      {
        // Absent keys are left untouched; `color: null` clears it, which is why
        // the two cases are distinguished rather than collapsed.
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.color === undefined ? {} : { color: parsed.data.color }),
      },
    );
    return NextResponse.json({ tag: toTagResponse(tag) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Deletes a tag and every assignment to it. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; tagId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, tagId } = await params;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid tag input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    await tagService().deleteTag(actorResult.actor, workspaceId, tagId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
