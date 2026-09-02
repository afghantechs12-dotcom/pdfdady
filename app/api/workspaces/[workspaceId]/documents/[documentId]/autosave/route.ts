import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError } from "@/src/application/services/workspaceHttp";
import { autosaveService, rejectOversizedBody, toAutosaveResponse } from "@/src/application/services/autosaveHttp";
import { AUTOSAVE_DRAFT_LIMITS as L } from "@/src/domain/entities/AutosaveDraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deviceId = z.string().min(1).max(L.maxDeviceIdLength);
const counter = z.number().int().min(0).max(L.maxCounter);

const saveSchema = z.object({
  organizationId: z.string().min(1),
  deviceId,
  baseVersion: counter,
  expectedRevision: counter,
  payload: z.string().min(1).max(L.maxPayloadBytes),
});

/** Lists the calling user's drafts for a document, or one device's draft. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const { workspaceId, documentId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  const device = request.nextUrl.searchParams.get("deviceId");
  try {
    if (device === null) {
      const drafts = await autosaveService().listDrafts(actorResult.actor, workspaceId, documentId);
      return NextResponse.json({ drafts: drafts.map(toAutosaveResponse) });
    }
    const draft = await autosaveService().getDraft(actorResult.actor, workspaceId, documentId, device);
    return NextResponse.json({ draft: draft ? toAutosaveResponse(draft) : null });
  } catch (error) { return mapWorkspaceError(request, error); }
}

/** Saves a draft: the snapshot goes to object storage, the row records it. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const oversized = rejectOversizedBody(request); if (oversized) return oversized;
  const { workspaceId, documentId } = await params;
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid autosave input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;
  try {
    const draft = await autosaveService().saveDraft(actorResult.actor, workspaceId, {
      documentId,
      deviceId: parsed.data.deviceId,
      baseVersion: parsed.data.baseVersion,
      expectedRevision: parsed.data.expectedRevision,
      payload: parsed.data.payload,
    });
    return NextResponse.json({ draft: toAutosaveResponse(draft) });
  } catch (error) { return mapWorkspaceError(request, error); }
}

/** Discards the calling user's draft for a device, row then snapshot. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = deviceId.safeParse(request.nextUrl.searchParams.get("deviceId"));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "deviceId is required.", 422);
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;
  try {
    const discarded = await autosaveService().discardDraft(actorResult.actor, workspaceId, documentId, parsed.data);
    return NextResponse.json({ discarded });
  } catch (error) { return mapWorkspaceError(request, error); }
}
