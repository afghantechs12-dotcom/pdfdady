import { notFound } from "next/navigation";
import type { Workspace } from "@/src/domain/entities/Workspace";
import type { WorkspaceRole } from "@/src/domain/entities/WorkspaceMembership";
import { NotFoundError } from "@/src/domain/errors";
import type { ActorContext } from "./WorkspaceService";

/** The part of `WorkspaceService` a page needs — kept structural so this module
 *  does not pull the DI container into a unit test. */
export interface WorkspaceReader {
  get(actor: ActorContext, workspaceId: string, write?: boolean): Promise<{ workspace: Workspace; role: WorkspaceRole }>;
}

/**
 * Resolves a Workspace for a server-rendered route, turning a refusal into
 * Next's controlled `notFound()` instead of an uncaught throw.
 *
 * Every Workspace page went through `service.get` directly, so a refused
 * lookup — an id that does not exist, one in another organization, one the actor
 * has no membership on — escaped the render as an exception. With no boundary on
 * `/workspaces`, Next answered with its generic "a server error occurred" page:
 * an expected authorization outcome presented as a crash. This is the one place
 * that mapping lives, so the three Workspace routes cannot drift apart.
 *
 * Only `NotFoundError` (and its `WorkspaceAccessError` subclass) becomes a 404.
 * A genuine infrastructure failure still propagates — a database outage must not
 * be silently reported to the user as "no such Workspace".
 */
export async function loadWorkspaceForRoute(
  service: WorkspaceReader,
  actor: ActorContext,
  workspaceId: string,
): Promise<{ workspace: Workspace; role: WorkspaceRole }> {
  return routeOr404(service.get(actor, workspaceId));
}

/**
 * The same mapping for any other resource a Workspace URL names — the document
 * id in `/workspaces/:id/documents/:documentId`, whose service refuses exactly
 * the same way and, before this, escaped the render exactly the same way.
 */
export async function routeOr404<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}
