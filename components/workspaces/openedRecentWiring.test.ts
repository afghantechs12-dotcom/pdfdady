import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T13/T14 wiring: `Opened` and `Recent` now mean something.
 *
 * Both were defects of absence, which is why source assertions carry this file.
 * `lastAccessedAt` had a column, an index, a sort option, a service method, a
 * repository method and a table heading — and no writer anywhere, so the column
 * read `—` for every document in the product. `view=recent` selected active
 * documents and changed neither order nor filter, so "Recent" was "All", sorted by
 * name, under an empty state promising recently opened documents.
 *
 * The behaviour of the pieces is tested where the pieces are: `touchAccessed` and
 * the Recent query in `DocumentRecordService.test.ts`. What is asserted here is
 * that a real open reaches them and that nothing else does.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const DOC_API = ["app", "api", "workspaces", "[workspaceId]", "documents", "[documentId]"];
const openedRoute = stripComments(read(...DOC_API, "opened", "route.ts"));
const contentRoute = stripComments(read(...DOC_API, "content", "route.ts"));
const metadataRoute = stripComments(read(...DOC_API, "metadata", "route.ts"));
const workbench = stripComments(read("components", "workspaces", "DocumentWorkbench.tsx"));
const prismaRepo = stripComments(
  read("src", "infrastructure", "persistence", "PrismaDocumentRecordRepository.ts"),
);

describe("T13 — an open is recorded by an explicit event", () => {
  it("is a POST that records the open and returns no document state", () => {
    expect(openedRoute).toContain("export async function POST(");
    expect(openedRoute).toContain(
      "documents.touchAccessed(actorResult.actor, workspaceId, documentId)",
    );
    expect(openedRoute).toContain("status: 204");
    // No GET. A timestamp written by a GET is written by a prefetch, a retry and a
    // range request too.
    expect(openedRoute).not.toContain("export async function GET(");
  });

  it("keeps every authorization the phase requires", () => {
    expect(openedRoute).toContain("requireSameOrigin(request)");
    // The organization is validated input, and the actor is re-resolved from the
    // session against it — the client names a Workspace, it does not grant one.
    expect(openedRoute).toContain("schema.safeParse(await request.json()");
    expect(openedRoute).toContain("getWorkspaceActor(request, parsed.data.organizationId)");
    expect(openedRoute).toContain('workspaceError(request, "INVALID_INPUT"');
    expect(openedRoute).toContain("mapWorkspaceError(request, error)");
  });

  it("cannot create a version or advance the revision", () => {
    // `touchAccessed` is the only write. Anything version-shaped here would make
    // opening a document a change to it.
    for (const forbidden of ["versions", "createVersion", "revision", "update("]) {
      expect(openedRoute).not.toContain(forbidden);
    }
  });

  it("fires when an editor finished loading the document, at both workbench mounts", () => {
    /*
     * The trigger is the load-succeeded callback, so `Opened` describes a document a
     * person actually saw. Two mounts because the second is the no-session
     * fallback — a viewer, whose open counts as much as a writer's.
     */
    expect(workbench.match(/recordDocumentOpened\(/g)).toHaveLength(3); // 1 definition + 2 mounts
    expect(workbench).toContain("onDocumentLoaded={handleLoaded}");
    // Whitespace-normalized: this asserts a wire, and a reflow by a formatter is
    // not a broken wire.
    const flat = workbench.replace(/\s+/g, " ");
    expect(flat).toContain(
      "onDocumentLoaded={() => recordDocumentOpened(workspaceId, organizationId, documentId)",
    );
    expect(workbench).toContain('method: "POST"');
    const helperAt = workbench.indexOf("function recordDocumentOpened");
    expect(helperAt).toBeGreaterThan(-1);
    expect(workbench.slice(helperAt)).toContain("/opened`");
  });

  it("is NOT recorded by fetching bytes or metadata", () => {
    /*
     * The two routes an open passes through on its way to the screen, and the two a
     * background card render passes through as well. If either wrote the timestamp,
     * `Opened` would move for a document nobody opened — and the content route
     * would write it two or three times for one open, since a scene and the pages it
     * sits on are separate requests.
     */
    for (const source of [contentRoute, metadataRoute]) {
      expect(source).not.toContain("touchAccessed");
      expect(source).not.toContain("touchLastAccessed");
    }
  });
});

describe("T14 — Recent lists what was opened", () => {
  it("filters to opened documents in the query, not in application memory", () => {
    expect(prismaRepo).toContain("if (query.openedOnly) where.lastAccessedAt = { not: null };");
    expect(prismaRepo).toContain('else if (sortBy === "lastAccessedAt") orderBy.push({ lastAccessedAt: sortOrder });');
    // A deterministic tie-breaker is what keeps cursor pagination from repeating or
    // skipping rows when several documents share a timestamp.
    expect(prismaRepo).toContain('orderBy.push({ id: "asc" });');
  });
});
