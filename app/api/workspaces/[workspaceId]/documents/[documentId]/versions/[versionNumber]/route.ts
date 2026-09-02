import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceActor, mapWorkspaceError, workspaceError } from "@/src/application/services/workspaceHttp";
import { toVersionResponse, versionService } from "@/src/application/services/versionHttp";
import { DOCUMENT_VERSION_LIMITS as L } from "@/src/domain/entities/DocumentVersion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Parses the path segment into a version number. A non-integer or out-of-range
 * segment is rejected rather than coerced, so a request for version "1e9999" or
 * "1.5" cannot reach the service as something it did not mean.
 */
function parseVersionNumber(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= L.maxCounter ? value : null;
}

type Params = { params: Promise<{ workspaceId: string; documentId: string; versionNumber: string }> };

/** A single version by number. `?verify=1` also recomputes its manifest checksum. */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId, documentId, versionNumber } = await params;
  const number = parseVersionNumber(versionNumber);
  if (number === null) return workspaceError(request, "INVALID_INPUT", "Invalid version number.", 422);

  const actorResult = await getWorkspaceActor(request, request.nextUrl.searchParams.get("organizationId") ?? undefined);
  if ("response" in actorResult) return actorResult.response;

  try {
    if (request.nextUrl.searchParams.get("verify") === "1") {
      const { version, intact } = await versionService().verifyVersion(actorResult.actor, workspaceId, documentId, number);
      return NextResponse.json({ version: toVersionResponse(version), intact });
    }
    const version = await versionService().getVersion(actorResult.actor, workspaceId, documentId, number);
    return NextResponse.json({ version: version ? toVersionResponse(version) : null });
  } catch (error) { return mapWorkspaceError(request, error); }
}
