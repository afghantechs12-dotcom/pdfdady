import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  commentService,
  toDocumentPermissionGrantResponse,
} from "@/src/application/services/commentHttp";
import { COLLABORATION_LIMITS as L } from "@/src/domain/entities/Collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  granteeUserId: z.string().min(1).max(L.maxIdLength),
  // The role allowlist lives in the domain; this only bounds what we parse.
  role: z.string().max(32),
  expiresAt: z.string().max(64).nullish(),
});

/** A document's shares. Workspace administration only. */
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

  const includeRevoked = request.nextUrl.searchParams.get("includeRevoked") === "true";
  const rawLimit = request.nextUrl.searchParams.get("limit");

  try {
    const grants = await commentService().listGrants(actorResult.actor, workspaceId, documentId, {
      includeRevoked,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });
    const now = new Date();
    return NextResponse.json({
      grants: grants.map((grant) => toDocumentPermissionGrantResponse(grant, now)),
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

/** Shares the document with a user, or re-points an existing share. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; documentId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "Invalid share.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const grant = await commentService().createGrant(actorResult.actor, workspaceId, documentId, {
      granteeUserId: parsed.data.granteeUserId,
      role: parsed.data.role,
      expiresAt: parsed.data.expiresAt,
    });
    return NextResponse.json(
      { grant: toDocumentPermissionGrantResponse(grant) },
      { status: 201 },
    );
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
