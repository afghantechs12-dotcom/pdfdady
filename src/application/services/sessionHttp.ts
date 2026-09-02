/**
 * HTTP shaping for M7.12 workspace tab sessions.
 *
 * The session routes are the client's only handle on the workbench's open-tab
 * state, so what crosses this boundary is bounded deliberately:
 *
 * - **No bytes, ever.** A session records logical references — document id,
 *   version id, title, bounded view state. No PDF bytes, no data URLs, no page
 *   backgrounds and no object-storage keys appear in any response or are
 *   accepted in any request.
 * - **Schema-versioned.** Every response carries `schema`, so a client that
 *   cached a session shape from an older deploy can tell rather than guess.
 * - **Workspace-pinned.** `TabService` scopes a session to its owner and
 *   organization; the routes additionally pin it to the Workspace in the path,
 *   so a session belonging to another Workspace cannot be driven through this
 *   one's URL even by its rightful owner.
 */

import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { TabService } from "./TabService";
import type {
  WorkspaceSession,
  WorkspaceSessionTab,
  WorkspaceSessionTabState,
} from "@/src/domain/entities/WorkspaceSession";

export function tabService(): TabService {
  return appContainer.resolve<TabService>(Tokens.TabService);
}

/** Current session-response schema. Bumped when the client-facing shape changes. */
export const WORKSPACE_SESSION_RESPONSE_SCHEMA = 1;

export interface TabStateResponse {
  activePage: number | null;
  viewport: { scale: number; offsetX: number; offsetY: number } | null;
  tool: string | null;
  selection: { start: number; end: number } | null;
  dirty: boolean;
  conflict: boolean;
  paneId: string | null;
  lastAccessed: string;
}

export interface TabResponse {
  id: string;
  documentId: string;
  versionId: string;
  title: string;
  state: TabStateResponse;
  createdAt: string;
  updatedAt: string;
}

export interface SessionResponse {
  schema: number;
  id: string;
  workspaceId: string;
  activeTabId: string | null;
  tabs: TabResponse[];
  /** Optimistic-concurrency counter. The client echoes it back on writes. */
  version: number;
  updatedAt: string;
}

/**
 * Projects a tab's view state.
 *
 * Absent optional values become explicit nulls rather than being omitted: a
 * client distinguishing "no viewport recorded" from "key missing from this
 * response" would otherwise have to guess, and guessing wrong resets a user's
 * scroll position.
 */
export function toTabStateResponse(state: WorkspaceSessionTabState): TabStateResponse {
  return {
    activePage: state.activePage ?? null,
    viewport: state.viewport
      ? {
          scale: state.viewport.scale,
          offsetX: state.viewport.offsetX,
          offsetY: state.viewport.offsetY,
        }
      : null,
    tool: state.tool ?? null,
    selection: state.selection ? { start: state.selection.start, end: state.selection.end } : null,
    dirty: state.dirty ?? false,
    conflict: state.conflict ?? false,
    paneId: state.paneId ?? null,
    lastAccessed: state.lastAccessed.toISOString(),
  };
}

export function toTabResponse(tab: WorkspaceSessionTab): TabResponse {
  return {
    id: tab.id,
    documentId: tab.documentId,
    versionId: tab.versionId,
    title: tab.title,
    state: toTabStateResponse(tab.state),
    createdAt: tab.createdAt.toISOString(),
    updatedAt: tab.updatedAt.toISOString(),
  };
}

/**
 * Projects a session.
 *
 * `userId` and `organizationId` are withheld: the caller is the owner by
 * construction, so echoing them adds nothing a client needs and puts tenant
 * identifiers into a payload that will sit in a browser's memory for as long as
 * the workbench is open.
 */
export function toSessionResponse(session: WorkspaceSession): SessionResponse {
  return {
    schema: WORKSPACE_SESSION_RESPONSE_SCHEMA,
    id: session.id,
    workspaceId: session.workspaceId,
    activeTabId: session.activeTabId,
    tabs: session.tabs.map(toTabResponse),
    version: session.version,
    updatedAt: session.updatedAt.toISOString(),
  };
}

/**
 * Whether a session may be driven through a given Workspace's routes.
 *
 * `TabService` already refuses a session the actor does not own and one from
 * another organization. This is the remaining check: a user with two Workspaces
 * owns sessions in both, and without pinning, a request to Workspace A's URL
 * carrying Workspace B's session id would operate on B while every log line and
 * audit entry said A.
 */
export function sessionBelongsToWorkspace(
  session: Pick<WorkspaceSession, "workspaceId">,
  workspaceId: string,
): boolean {
  return session.workspaceId === workspaceId;
}

/**
 * Rejects tab-state input carrying anything that is not bounded view state.
 *
 * The service normalizes and bounds what it recognizes, but a payload naming a
 * content URL, a data URL or a storage key signals a client trying to push
 * document content through the session store. That is refused at the boundary
 * rather than quietly dropped, so the caller learns its request was wrong.
 */
const FORBIDDEN_STATE_KEYS = [
  "bytes",
  "content",
  "contenturl",
  "data",
  "dataurl",
  "background",
  "backgrounds",
  "image",
  "images",
  "thumbnail",
  "thumbnails",
  "key",
  "storagekey",
  "sourcekey",
  "url",
  "src",
  "blob",
  "pdf",
];

export function tabStateInputRejection(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "Tab state must be an object.";
  }
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (FORBIDDEN_STATE_KEYS.includes(key.toLowerCase())) {
      return "Tab state may not carry document content or storage references.";
    }
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && /^(data|blob):/i.test(value.trim())) {
      return "Tab state may not carry inline document content.";
    }
  }
  return null;
}
