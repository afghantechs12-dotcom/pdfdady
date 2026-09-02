import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor, mapWorkspaceError, requireSameOrigin, workspaceError } from "@/src/application/services/workspaceHttp";
import { toVersionResponse, versionService } from "@/src/application/services/versionHttp";
import { withCreatedByIdentities } from "@/src/application/services/memberDirectory";
import { DOCUMENT_VERSION_LIMITS as L } from "@/src/domain/entities/DocumentVersion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const counter = z.number().int().min(0).max(L.maxCounter);
const key = z.string().min(1).max(L.maxKeyLength);
const checksum = z.string().min(1).max(L.maxChecksumLength);

/**
 * The manifest a client may submit. Every field is bounded here and validated
 * again in the domain, so a request that slips past one shape still cannot store
 * an unbounded artifact reference. `origin` omits "restore": restore provenance
 * is set by the restore route, never claimed by a save.
 */
const manifestSchema = z.object({
  sourceKey: key,
  sourceChecksum: checksum,
  sourceByteSize: z.number().int().min(0).max(L.maxArtifactBytes),
  editorStateKey: key.nullish(),
  editorStateChecksum: checksum.nullish(),
  outputKey: key.nullish(),
  outputChecksum: checksum.nullish(),
  pageCount: counter.nullish(),
  thumbnailKeys: z.array(key).max(L.maxThumbnailKeys).optional(),
});

const createSchema = z.object({
  organizationId: z.string().min(1),
  expectedRevision: counter,
  origin: z.enum(["save", "import", "checkpoint"]).optional(),
  label: z.string().max(L.maxLabelLength).nullish(),
  manifest: manifestSchema,
});

/** Version history for a document, newest first. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const { workspaceId, documentId } = await params;
  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const rawBefore = request.nextUrl.searchParams.get("before");
  const limit = rawLimit === null ? L.defaultListLimit : Number(rawLimit);
  const before = rawBefore === null ? undefined : Number(rawBefore);
  if (before !== undefined && !Number.isInteger(before)) {
    return workspaceError(request, "INVALID_INPUT", "before must be a version number.", 422);
  }

  try {
    const versions = await versionService().listVersions(actorResult.actor, workspaceId, documentId, limit, before);
    // Author names resolved in ONE batched query, not one per row. The panel used
    // to have nothing but `createdById` (a cuid) to show for "who saved this".
    return NextResponse.json({ versions: await withCreatedByIdentities(versions.map(toVersionResponse)) });
  } catch (error) { return mapWorkspaceError(request, error); }
}

/** Creates a durable version, compare-and-swapping against the document revision. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; documentId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const { workspaceId, documentId } = await params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return workspaceError(request, "INVALID_INPUT", "Invalid version input.", 422);
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const version = await versionService().createVersion(actorResult.actor, workspaceId, {
      documentId,
      expectedRevision: parsed.data.expectedRevision,
      origin: parsed.data.origin,
      label: parsed.data.label ?? null,
      manifest: parsed.data.manifest,
    });
    return NextResponse.json({ version: toVersionResponse(version) });
  } catch (error) { return mapWorkspaceError(request, error); }
}
