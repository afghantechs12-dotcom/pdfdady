import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getWorkspaceActor,
  mapWorkspaceError,
  requireSameOrigin,
  workspaceError,
  workspaceServices,
} from "@/src/application/services/workspaceHttp";
import { commandPaletteService, toCommandResponse } from "@/src/application/services/commandHttp";
import { COMMAND_LIMITS as L } from "@/src/domain/entities/CommandPalette";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

/**
 * Lists the commands available in a context.
 *
 * A read, so no CSRF check: the response is a catalogue, and every entry in it
 * is re-authorized when the client asks to run it.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId") ?? undefined;
  const query = url.searchParams.get("q") ?? "";
  if (query.length > L.maxQueryLength) {
    return workspaceError(request, "INVALID_INPUT", "That search query is too long.", 422);
  }

  const actorResult = await getWorkspaceActor(request, organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    // The Workspace read decides whether this actor may see the catalogue at
    // all, and supplies the role the context is built from — the client's own
    // claim about its permissions is not trusted.
    const { role } = await workspaceServices().workspaces.get(
      actorResult.actor,
      workspaceId,
      false,
    );

    const commands = commandPaletteService().search(query, {
      hasDocument: url.searchParams.get("hasDocument") === "true",
      hasSelection: url.searchParams.get("hasSelection") === "true",
      canWrite: role !== "viewer",
      isSplit: url.searchParams.get("isSplit") === "true",
      activePane: url.searchParams.get("activePane") === "right" ? "right" : "left",
      activeDocumentId: url.searchParams.get("documentId"),
    });

    return NextResponse.json({ commands: commands.map(toCommandResponse) });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}

const executeSchema = z.object({
  organizationId: z.string().min(1).max(L.maxIdLength),
  commandId: z.string().min(1).max(L.maxIdLength),
  documentId: z.string().min(1).max(L.maxIdLength).nullish(),
  paneId: z.enum(["left", "right"]).optional(),
});

/**
 * Resolves and authorizes a command execution.
 *
 * Deliberately not a general execution endpoint: the id is looked up in the
 * server's own registry and anything unregistered is refused, so the route can
 * only ever reach an allowlisted command. What comes back is the *resolved
 * target* — the command, Workspace, document and pane the client may now act on
 * through the feature's own API. The palette does not become a second, weaker
 * path into every feature.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const { workspaceId } = await params;

  const parsed = executeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return workspaceError(request, "INVALID_INPUT", "A valid command request is required.", 422);
  }
  const actorResult = await getWorkspaceActor(request, parsed.data.organizationId);
  if ("response" in actorResult) return actorResult.response;

  try {
    const result = await commandPaletteService().execute(actorResult.actor, {
      commandId: parsed.data.commandId,
      workspaceId,
      documentId: parsed.data.documentId ?? null,
      paneId: parsed.data.paneId,
    });
    return NextResponse.json({
      command: {
        commandId: result.commandId,
        documentId: result.documentId,
        paneId: result.paneId,
      },
    });
  } catch (error) {
    return mapWorkspaceError(request, error);
  }
}
