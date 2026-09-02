import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T18 wiring: an activity line can only name what the WRITE recorded.
 *
 * `describeActivity` is tested where it lives, and it now prefers the event's own
 * `documentName`. That preference is worth nothing if no route ever records one —
 * which was exactly the state of the product: every audit entry had an action, an
 * actor and a resource id, and no metadata at all, so the dashboard's only source
 * of a name was the page of 50 documents it happened to have loaded. Hence source
 * assertions: this is a defect of absence at the write sites.
 *
 * The second half of this file is the constraint on that metadata. Activity records
 * a document's NAME and never its contents — no page text, no annotations, no form
 * values, no bytes — and the readable way to hold that line is to enumerate the
 * keys each route is allowed to write and fail on anything else.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const WS_API = ["app", "api", "workspaces", "[workspaceId]", "documents"];
const routes = {
  upload: stripComments(read(...WS_API, "upload", "route.ts")),
  versionUpload: stripComments(read(...WS_API, "[documentId]", "versions", "upload", "route.ts")),
  documentMutations: stripComments(read(...WS_API, "[documentId]", "route.ts")),
  create: stripComments(read(...WS_API, "route.ts")),
  lifecycle: stripComments(read(...WS_API, "[documentId]", "lifecycle", "route.ts")),
  jobSave: stripComments(read("app", "api", "jobs", "[id]", "save-to-workspace", "route.ts")),
};
const dashboardPage = stripComments(read("app", "workspaces", "[workspaceId]", "page.tsx"));
const dashboardLogic = stripComments(read("components", "workspaces", "dashboardLogic.ts"));

describe("T18 — every document event records the name it will be described by", () => {
  it("records a document name on create, upload, rename, move and lifecycle", () => {
    expect(routes.create).toContain('action: "document.create"');
    expect(routes.create).toContain("metadata: { documentName: document.name }");

    expect(routes.upload).toContain('action: "document.upload"');
    expect(routes.upload).toContain("metadata: { documentName: result.document.name }");

    expect(routes.documentMutations).toContain('action: "document.move"');
    expect(routes.documentMutations).toContain('action: "document.rename"');
    // Both mutations on this route, so a count rather than a containment: one of
    // the two carrying metadata and the other not is the failure to catch.
    expect(routes.documentMutations.split("metadata: { documentName: document.name }").length - 1).toBe(2);

    expect(routes.lifecycle).toContain(
      "metadata: { documentName: document.name, state: parsed.data.state }",
    );
  });

  it("records the version number a publish produced, and not the uploaded file's name", () => {
    expect(routes.versionUpload).toContain('action: "document.version.create"');
    expect(routes.versionUpload).toContain("metadata: { versionNumber: version.versionNumber }");
    // The version's own file name is not the document's name. Recording it as
    // `documentName` would put a misleading name in the feed for every publish
    // whose exported file happened to be called something else.
    expect(routes.versionUpload).not.toContain("documentName");
  });

  it("records which tool a cloud result was saved from", () => {
    expect(routes.jobSave).toContain("documentName: result.document.name");
    expect(routes.jobSave).toContain("toolSlug: row?.toolSlug ?? null");
  });
});

describe("T18 — activity metadata carries names, never document contents", () => {
  /** Every key any route writes into an audit `metadata` object literal. */
  const metadataKeys = (source: string): string[] => {
    const keys: string[] = [];
    for (const match of source.matchAll(/metadata:\s*\{/g)) {
      let depth = 0;
      let i = match.index! + match[0].length - 1;
      const start = i;
      for (; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = source.slice(start, i + 1);
      for (const key of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.push(key[1]);
    }
    return keys;
  };

  it("writes only the fields the audit convention allows", () => {
    // The allow-list IS the constraint: document ID, filename, tool slug, version
    // number. A new key here is a deliberate decision, not an accident of passing
    // an object through.
    const allowed = new Set(["documentName", "versionNumber", "toolSlug", "state", "documentId"]);
    for (const [name, source] of Object.entries(routes)) {
      for (const key of metadataKeys(source)) {
        expect(allowed.has(key), `${name} records metadata key "${key}"`).toBe(true);
      }
    }
  });

  it("records nothing derived from the document's contents", () => {
    // The bytes are in scope in several of these routes — `data`, the parsed
    // upload, the extracted text — which is exactly why this is asserted rather
    // than assumed.
    for (const [name, source] of Object.entries(routes)) {
      for (const key of metadataKeys(source)) {
        expect(
          /text|content|bytes|annotation|form|field|signature|password|body/i.test(key),
          `${name} records metadata key "${key}"`,
        ).toBe(false);
      }
    }
  });
});

describe("T18 — the recorded name reaches the rendered line", () => {
  it("threads the event's metadata through the dashboard page", () => {
    // Without this one line the whole write side is dead weight: `describeActivity`
    // would keep falling back to the page's 50-document map.
    expect(dashboardPage).toContain("metadata: entry.metadata,");
    expect(dashboardPage).toContain(
      "resourceLabel: entry.resourceId ? (documentNames[entry.resourceId] ?? null) : null,",
    );
  });

  it("prefers the event's name and keeps the page's as the historical fallback", () => {
    expect(dashboardLogic).toContain('const named = metaText(entry.metadata, "documentName");');
    expect(dashboardLogic).toContain('const document = named ?? entry.resourceLabel ?? "a document";');
    expect(dashboardLogic).toContain('const subject = named ?? entry.resourceLabel ?? "an item";');
  });

  it("reads metadata through checked accessors rather than casting a value into a sentence", () => {
    // The values arrive as parsed JSON from a nullable text column. A direct
    // `metadata.documentName` would render "undefined" or "[object Object]" into
    // the feed the first time an old entry or a mis-shaped record came through.
    expect(dashboardLogic).toContain("function metaText(metadata: unknown, key: string)");
    expect(dashboardLogic).toContain("function metaCount(metadata: unknown, key: string)");
    expect(dashboardLogic).not.toMatch(/entry\.metadata\s*\.\s*[A-Za-z]/);
  });
});
