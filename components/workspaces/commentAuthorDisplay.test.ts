import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The comment author/timestamp display contract.
 *
 * Two visible defects are pinned here, plus the invariant that keeps them fixed:
 *
 *  - `CommentsPanel` rendered `authorName ?? authorId`, printing a raw cuid as a
 *    person's name whenever the API omitted a name — which it always did.
 *  - It rendered `createdAt.slice(0, 16).replace("T", " ")`: a sliced ISO string
 *    in UTC, so a comment posted a minute ago showed the wrong wall-clock time.
 *
 * The invariant: EVERY comment endpoint decorates its messages/threads with
 * resolved identities. The panel's types cannot enforce this — the client reads
 * `response.json()` as `any` — so a route that forgot to decorate would ship a
 * silently id-labelled comment. Hence a test over the route files themselves.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const panel = read("components", "workspaces", "CommentsPanel.tsx");

/** Every route.ts under the comments API tree. */
function commentRoutes(): Array<{ path: string; source: string }> {
  const base = join(
    ROOT,
    "app", "api", "workspaces", "[workspaceId]", "documents", "[documentId]", "comments",
  );
  const out: Array<{ path: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") out.push({ path: full, source: readFileSync(full, "utf8") });
    }
  };
  walk(base);
  return out;
}

describe("the panel never renders an internal identifier as a person", () => {
  it("dropped the raw-authorId fallback", () => {
    expect(panel).not.toMatch(/authorName \?\? entry\.authorId/);
    expect(panel).not.toMatch(/\?\? *entry\.authorId/);
  });

  it("renders the resolved name directly", () => {
    expect(panel).toMatch(/\{entry\.authorName\}/);
  });

  it("requires authorName in the view type rather than leaving it optional", () => {
    // Optionality is what permitted the silent id fallback.
    expect(panel).toMatch(/authorName: string;/);
    expect(panel).not.toMatch(/authorName\?: string/);
  });
});

describe("the panel never renders a raw ISO timestamp", () => {
  it("dropped the ISO slice", () => {
    expect(panel).not.toMatch(/createdAt\.slice\(/);
    expect(panel).not.toMatch(/replace\("T", " "\)/);
  });

  it("shows a local relative time while keeping the machine-readable instant", () => {
    expect(panel).toMatch(/relativeCommentTime\(entry\.createdAt\)/);
    // `dateTime` must still carry the exact ISO value for assistive tech.
    expect(panel).toMatch(/dateTime=\{entry\.createdAt\}/);
  });
});

describe("every comment endpoint resolves author identities", () => {
  it("finds the comment route tree", () => {
    expect(commentRoutes().length).toBeGreaterThanOrEqual(6);
  });

  it("decorates every serialized message and thread it returns", () => {
    for (const { path, source } of commentRoutes()) {
      // A route that serializes a message/thread must also decorate it. Checking
      // per-route rather than globally: the failure mode is ONE forgotten route.
      if (/toCommentMessageResponse/.test(source)) {
        expect(source, `${path} serializes messages without resolving authors`).toMatch(
          /withCommentAuthors/,
        );
      }
      if (/toCommentThreadResponse/.test(source)) {
        expect(source, `${path} serializes threads without resolving authors`).toMatch(
          /withThreadAuthors/,
        );
      }
    }
  });

  it("covers at least the list, create, edit, delete, resolve and reopen paths", () => {
    const decorated = commentRoutes().filter(
      (r) => /withCommentAuthors|withThreadAuthors/.test(r.source),
    );
    expect(decorated.length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * The Comments tab crashed for every workspace document that had a thread.
 *
 * Found by the Phase H browser probe, not by the suite: the list route returned
 * thread SUMMARIES (`toCommentThreadResponse` has no `messages` field), the
 * inspector passed them straight into `CommentsPanel`, and the panel's very
 * first render read `thread.messages.length` — so the tab threw
 * `TypeError: Cannot read properties of undefined (reading 'length')` and
 * rendered nothing at all. Types could not catch it: the client reads
 * `response.json()` as `any`.
 *
 * These tests pin the shape the panel requires against the route that has to
 * produce it, and the batching that keeps it from becoming an N+1.
 */
describe("the comments listing carries the conversation the panel renders", () => {
  const listRoute = read(
    "app", "api", "workspaces", "[workspaceId]", "documents", "[documentId]", "comments", "route.ts",
  );
  const service = read("src", "application", "services", "CommentService.ts");

  it("the panel still reads messages off each thread (the crash site)", () => {
    // If this stops being true the tests below are guarding nothing.
    expect(panel).toMatch(/thread\.messages\.length/);
    expect(panel).toMatch(/messages: CommentMessageView\[\];/);
  });

  it("the list route returns a messages array on every thread", () => {
    expect(listRoute).toMatch(/listThreadsWithMessages/);
    expect(listRoute).toMatch(/messages: byThread\.get\(thread\.id\) \?\? \[\]/);
  });

  it("resolves identities in batched passes, not once per thread", () => {
    // The whole page is flattened into ONE withCommentAuthors call. A
    // per-thread call inside a map/loop is the N+1 this must not become.
    expect(listRoute).toMatch(/flatMap\(\(entry\) => entry\.messages\.map\(toCommentMessageResponse\)\)/);
    // Scoped to the GET handler: POST legitimately decorates its own created
    // thread, so counting across the whole file would prove nothing.
    const get = listRoute.slice(
      listRoute.indexOf("export async function GET"),
      listRoute.indexOf("export async function POST"),
    );
    expect(get).not.toBe("");
    expect(get.match(/withCommentAuthors\(/g) ?? []).toHaveLength(1);
    expect(get.match(/withThreadAuthors\(/g) ?? []).toHaveLength(1);
  });

  it("loads each thread's messages concurrently and within the domain limit", () => {
    expect(service).toMatch(/async listThreadsWithMessages/);
    expect(service).toMatch(/await Promise\.all\(/);
    // Bounded: never an unbounded read per thread.
    expect(service).toMatch(/limit: collaborationListLimit\(undefined\)/);
  });

  it("reports each thread's real staleness rather than defaulting it", () => {
    // `toCommentThreadResponse(thread)` defaults `stale` to false; the listing
    // knows the true value, so it must pass it.
    expect(listRoute).toMatch(/toCommentThreadResponse\(entry\.thread, entry\.stale\)/);
  });
});
