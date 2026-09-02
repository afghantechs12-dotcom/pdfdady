import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { withCreatedByIdentities } from "./memberDirectory";
import { toVersionResponse } from "./versionHttp";
import { DOCUMENT_VERSION_MANIFEST_SCHEMA } from "@/src/domain/entities/DocumentVersion";

/**
 * Version history names the person who saved each version (Phase H, H35).
 *
 * The panel had only `createdById` — an internal cuid — to show for "who saved
 * this", the same defect the comment panel had. This asserts the shared
 * resolution path is used and that it stays ONE query per page.
 *
 * ## Why a single module-level stub
 *
 * The DI container is a service locator with singleton caching: `resolve`
 * memoizes, so a `register` issued after the first resolve is a no-op. Registering
 * per-test would silently keep whichever stub ran first. One stub with mutable
 * module state is registered once, and each test resets that state.
 */

type Row = { id: string; email: string | null; name: string | null };

let calls: Array<{ where: unknown; select: unknown }> = [];
let rows: Row[] = [];
let failing = false;

appContainer.register(Tokens.PrismaClient, () => ({
  user: {
    findMany: async (args: { where: unknown; select: unknown }) => {
      calls.push(args);
      if (failing) throw new Error("directory unavailable");
      return rows;
    },
  },
}));

beforeEach(() => {
  calls = [];
  rows = [];
  failing = false;
});

describe("withCreatedByIdentities", () => {
  it("prefers the display name", async () => {
    rows = [{ id: "u1", email: "ada@example.com", name: "Ada Lovelace" }];
    const [out] = await withCreatedByIdentities([{ createdById: "u1", versionNumber: 3 }]);
    expect(out.createdByName).toBe("Ada Lovelace");
    expect(out.createdByInitials).toBe("AL");
  });

  it("falls back to the email when there is no name", async () => {
    rows = [{ id: "u1", email: "ada@example.com", name: null }];
    const [out] = await withCreatedByIdentities([{ createdById: "u1" }]);
    expect(out.createdByName).toBe("ada@example.com");
  });

  it("falls back to a shortened id when the identity does not resolve", async () => {
    rows = [];
    const [out] = await withCreatedByIdentities([{ createdById: "cmg7x2k9b0001abcdef" }]);
    expect(out.createdByName).toBe("Unknown user · cmg7x2k9");
    // Never the full cuid, and never an empty string that renders as a gap.
    expect(out.createdByName).not.toContain("cmg7x2k9b0001abcdef");
  });

  it("issues exactly one query for a page with repeated authors", async () => {
    rows = [
      { id: "u1", email: "a@example.com", name: "A" },
      { id: "u2", email: "b@example.com", name: "B" },
    ];
    const out = await withCreatedByIdentities([
      { createdById: "u1" },
      { createdById: "u2" },
      { createdById: "u1" },
      { createdById: "u2" },
      { createdById: "u1" },
    ]);
    expect(out).toHaveLength(5);
    expect(calls).toHaveLength(1);
    // Deduplicated: five rows, two ids in the `in` clause.
    expect((calls[0].where as { id: { in: string[] } }).id.in.sort()).toEqual(["u1", "u2"]);
  });

  it("never selects a credential field", async () => {
    rows = [];
    await withCreatedByIdentities([{ createdById: "u1" }]);
    expect(Object.keys(calls[0].select as object).sort()).toEqual(["email", "id", "name"]);
  });

  it("issues no query for an empty page", async () => {
    await withCreatedByIdentities([]);
    expect(calls).toHaveLength(0);
  });

  it("degrades to ids when the directory fails, rather than failing the list", async () => {
    failing = true;
    const [out] = await withCreatedByIdentities([{ createdById: "u1234567890" }]);
    expect(out.createdByName).toBe("Unknown user · u1234567");
  });

  it("preserves every other field on the row", async () => {
    rows = [{ id: "u1", email: null, name: "Ada" }];
    const [out] = await withCreatedByIdentities([
      { createdById: "u1", versionNumber: 7, origin: "restore", manifestDegraded: false },
    ]);
    expect(out.versionNumber).toBe(7);
    expect(out.origin).toBe("restore");
    expect(out.manifestDegraded).toBe(false);
  });
});

describe("the versions route names its authors", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const versionsDir = join(
    ROOT,
    "app",
    "api",
    "workspaces",
    "[workspaceId]",
    "documents",
    "[documentId]",
    "versions",
  );
  const listRoute = readFileSync(join(versionsDir, "route.ts"), "utf8");

  it("decorates the version list with resolved identities", () => {
    expect(listRoute).toContain("withCreatedByIdentities");
  });

  it("decorates once for the whole page, not per row", () => {
    // A `.map(... await ...)` would reintroduce the N+1 this replaced.
    expect(listRoute).not.toMatch(/map\(\s*async/);
    expect(listRoute.match(/withCreatedByIdentities/g)).toHaveLength(2); // import + one call
  });

  it("still withholds storage keys — decoration must not widen the response", async () => {
    // Asserted on the real OUTPUT rather than on source text: the serializer
    // legitimately *reads* `manifest.outputKey` to compute a `hasOutput` boolean,
    // so a regex over its body would fail on a correct implementation. What
    // matters is which keys reach the client.
    rows = [{ id: "u1", email: null, name: "Ada" }];
    const [decorated] = await withCreatedByIdentities([
      toVersionResponse({
        id: "ver-1",
        workspaceId: "ws-1",
        organizationId: "org-1",
        documentId: "doc-1",
        versionNumber: 2,
        revision: 1,
        origin: "save",
        restoredFromVersionId: null,
        label: null,
        manifest: {
          schema: DOCUMENT_VERSION_MANIFEST_SCHEMA,
          sourceKey: "secret/tenant-a/source.pdf",
          sourceChecksum: "aaa",
          sourceByteSize: 10,
          editorStateKey: "secret/tenant-a/state.json",
          editorStateChecksum: "bbb",
          outputKey: "secret/tenant-a/out.pdf",
          outputChecksum: "ccc",
          pageCount: 3,
          thumbnailKeys: ["secret/tenant-a/t1.png"],
        },
        manifestDegraded: false,
        checksum: "ddd",
        createdById: "u1",
        createdAt: new Date("2026-08-17T12:00:00.000Z"),
      }),
    ]);

    const serialized = JSON.stringify(decorated);
    expect(serialized).not.toContain("secret/tenant-a");
    for (const key of ["sourceKey", "editorStateKey", "outputKey", "thumbnailKeys"]) {
      expect(Object.keys(decorated)).not.toContain(key);
    }
    // Decoration adds display identity only.
    expect(decorated.createdByName).toBe("Ada");
    expect(decorated.thumbnailCount).toBe(1);
    expect(decorated.hasOutput).toBe(true);
  });

  it("comment threads and version rows share one resolution path", () => {
    // Two copies of the fallback order would eventually disagree about how a
    // person is named in two panels.
    const commentHttp = readFileSync(
      join(ROOT, "src", "application", "services", "commentHttp.ts"),
      "utf8",
    );
    expect(commentHttp).toContain("withCreatedByIdentities");
    // `withThreadAuthors` must delegate, not re-implement.
    const threadAuthors = commentHttp.slice(commentHttp.indexOf("export async function withThreadAuthors"));
    expect(threadAuthors).not.toContain("memberDisplayName");
  });
});

describe("every version route that serializes versions is accounted for", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const versionsDir = join(
    ROOT,
    "app",
    "api",
    "workspaces",
    "[workspaceId]",
    "documents",
    "[documentId]",
    "versions",
  );

  /** Walks the versions route tree so a new route cannot be forgotten. */
  function routeFiles(dir: string): Array<{ path: string; source: string }> {
    const out: Array<{ path: string; source: string }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...routeFiles(full));
      else if (entry.name === "route.ts") out.push({ path: full, source: readFileSync(full, "utf8") });
    }
    return out;
  }

  it("finds the list route and the restore route", () => {
    const files = routeFiles(versionsDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((f) => f.path.endsWith(join("versions", "route.ts")))).toBe(true);
    expect(files.some((f) => f.path.includes("restore"))).toBe(true);
  });

  it("any route returning a LIST of versions resolves author names", () => {
    // Single-version responses (restore) are excluded deliberately: the panel
    // refetches the list after a restore, so the created row gets its name from
    // that read rather than from a second batched lookup here.
    for (const file of routeFiles(versionsDir)) {
      if (!/versions:\s*/.test(file.source)) continue;
      expect(file.source, `${file.path} returns a version list without author names`).toContain(
        "withCreatedByIdentities",
      );
    }
  });

  it("the restore route still enforces compare-and-swap", () => {
    const restore = routeFiles(versionsDir).find((f) => f.path.includes("restore"));
    expect(restore).toBeDefined();
    expect(restore?.source).toContain("expectedRevision");
    // Same-origin check and an authenticated actor, unchanged by this work.
    expect(restore?.source).toContain("requireSameOrigin");
    expect(restore?.source).toContain("getWorkspaceActor");
  });
});
