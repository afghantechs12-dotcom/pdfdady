import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
} from "@/src/application/services/workspaceHttp";
import {
  operationCenterService,
  toOperationResponse,
} from "@/src/application/services/commandHttp";
import { COMMAND_LIMITS as L } from "@/src/domain/entities/CommandPalette";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
});

type Params = { params: Promise<{ workspaceId: string; operationId: string }> };

/**
 * Retries a finished operation by starting a new one.
 *
 * The original terminal record is left exactly as it was. Resetting it would
 * erase the fact that the work failed, and a user deciding whether to try again
 * needs to see that it has already failed twice.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId, operationId } = await params;
  if (operationId.length > L.maxIdLength) {
    return workspaceError(request, "NOT_FOUND", "Operation not found.", 404);
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "organizationId is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const operation = await operationCenterService().retry(
      actorResult.actor,
      workspaceId,
      operationId,
    );
    return NextResponse.json({ operation: toOperationResponse(operation) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
