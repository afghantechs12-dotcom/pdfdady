import type { PrismaClient, WorkspaceSession as WorkspaceSessionRow } from "@prisma/client";
import type { WorkspaceSession, WorkspaceSessionTab } from "@/src/domain/entities/WorkspaceSession";
import { WORKSPACE_SESSION_LIMITS as L } from "@/src/domain/entities/WorkspaceSession";
import { isPaneId } from "@/src/domain/entities/SplitView";
import type {
  WorkspaceSessionRepository,
  WorkspaceSessionUpsertInput,
} from "@/src/application/ports/workspaces/WorkspaceSessionRepository";

/** A `data:`/`blob:` URL is how document bytes would sneak into a text field. */
const CONTENT_URL_PATTERN = /^\s*(?:data|blob):/i;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  if (CONTENT_URL_PATTERN.test(value)) return null;
  return value;
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/**
 * Rehydrates one persisted tab, re-applying the domain bounds.
 *
 * The stored payload is validated on write, but a row could predate a bound or
 * have been altered out of band, so every field is re-checked here: an
 * out-of-range view-state value is dropped to undefined rather than returned,
 * and a tab missing a usable identity is discarded by the caller.
 */
function parseTab(entry: unknown): WorkspaceSessionTab | null {
  if (!entry || typeof entry !== "object") return null;
  const t = entry as Record<string, unknown>;

  const id = boundedString(t.id, L.maxIdLength);
  const documentId = boundedString(t.documentId, L.maxIdLength);
  if (!id || !documentId) return null;

  const rawState = t.state && typeof t.state === "object" ? (t.state as Record<string, unknown>) : {};
  const viewport =
    rawState.viewport && typeof rawState.viewport === "object"
      ? (rawState.viewport as Record<string, unknown>)
      : null;

  const scale = viewport ? boundedNumber(viewport.scale, L.minScale, L.maxScale) : undefined;
  const offsetX = viewport ? boundedNumber(viewport.offsetX, -L.maxOffset, L.maxOffset) : undefined;
  const offsetY = viewport ? boundedNumber(viewport.offsetY, -L.maxOffset, L.maxOffset) : undefined;

  const selection =
    rawState.selection && typeof rawState.selection === "object"
      ? (rawState.selection as Record<string, unknown>)
      : null;
  const start = selection ? boundedNumber(selection.start, 0, L.maxSelectionOffset) : undefined;
  const end = selection ? boundedNumber(selection.end, 0, L.maxSelectionOffset) : undefined;

  const epoch = new Date(0);
  return {
    id,
    documentId,
    versionId: boundedString(t.versionId, L.maxIdLength) ?? "",
    title: boundedString(t.title, L.maxTitleLength) ?? "",
    state: {
      activePage: boundedNumber(rawState.activePage, 1, L.maxPage),
      viewport:
        scale !== undefined && offsetX !== undefined && offsetY !== undefined
          ? { scale, offsetX, offsetY }
          : undefined,
      tool: boundedString(rawState.tool, L.maxToolLength) ?? undefined,
      selection: start !== undefined && end !== undefined && end >= start ? { start, end } : undefined,
      dirty: optionalBoolean(rawState.dirty),
      conflict: optionalBoolean(rawState.conflict),
      // An unrecognized pane degrades to absent, which reads as the primary
      // pane — a row from a newer build must not name a pane this build cannot
      // render.
      paneId: isPaneId(rawState.paneId) ? rawState.paneId : undefined,
      lastAccessed: parseDate(rawState.lastAccessed, epoch),
    },
    createdAt: parseDate(t.createdAt, epoch),
    updatedAt: parseDate(t.updatedAt, epoch),
  };
}

/**
 * Rehydrates the JSON-serialized tab array. Dates survive JSON as ISO strings,
 * so they are converted back explicitly. A payload that is not a well-formed
 * array is treated as empty rather than thrown: a corrupt session should cost
 * the user their tab layout, not lock them out of the Workspace. The tab count
 * is truncated to the domain maximum for the same reason.
 */
function parseTabs(raw: string): WorkspaceSessionTab[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const tabs: WorkspaceSessionTab[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (tabs.length >= L.maxTabs) break;
    const tab = parseTab(entry);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  return tabs;
}

function toDomain(row: WorkspaceSessionRow): WorkspaceSession {
  const tabs = parseTabs(row.tabs);
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    // A tab dropped by validation must not leave the active pointer dangling.
    activeTabId: tabs.some((t) => t.id === row.activeTabId) ? row.activeTabId : null,
    tabs,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaWorkspaceSessionRepository implements WorkspaceSessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getForUser(workspaceId: string, userId: string): Promise<WorkspaceSession | null> {
    const row = await this.prisma.workspaceSession.findFirst({ where: { workspaceId, userId } });
    return row ? toDomain(row) : null;
  }

  async getByIdForUser(sessionId: string, userId: string): Promise<WorkspaceSession | null> {
    // userId is part of the predicate, not a post-read check, so another user's
    // session is never loaded into memory in the first place.
    const row = await this.prisma.workspaceSession.findFirst({ where: { id: sessionId, userId } });
    return row ? toDomain(row) : null;
  }

  async create(input: WorkspaceSessionUpsertInput): Promise<WorkspaceSession> {
    const existing = await this.getForUser(input.workspaceId, input.userId);
    if (existing) return existing;

    const row = await this.prisma.workspaceSession.create({
      data: {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        userId: input.userId,
        activeTabId: input.activeTabId,
        tabs: JSON.stringify(input.tabs),
      },
    });
    return toDomain(row);
  }

  async update(
    sessionId: string,
    userId: string,
    data: { activeTabId: string | null; tabs: WorkspaceSessionTab[] },
    expectedVersion?: number,
  ): Promise<WorkspaceSession | null> {
    // updateMany lets the owner and version predicates live in the WHERE clause,
    // making the version check atomic rather than read-then-write.
    const where: { id: string; userId: string; version?: number } = { id: sessionId, userId };
    if (expectedVersion !== undefined) where.version = expectedVersion;

    const result = await this.prisma.workspaceSession.updateMany({
      where,
      data: {
        activeTabId: data.activeTabId,
        tabs: JSON.stringify(data.tabs),
        version: { increment: 1 },
      },
    });
    if (result.count === 0) return null;

    return this.getByIdForUser(sessionId, userId);
  }

  async delete(sessionId: string, userId: string): Promise<boolean> {
    const result = await this.prisma.workspaceSession.deleteMany({ where: { id: sessionId, userId } });
    return result.count > 0;
  }
}
