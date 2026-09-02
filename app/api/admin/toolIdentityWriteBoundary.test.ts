import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_TOOL_IDENTITY_ERROR } from "@/lib/tools/capability";

/**
 * T9 — the admin write boundary refuses a tool identity the code does not implement.
 *
 * The client no longer offers a "New tool" button, but a disabled button is not a
 * policy: the store is written by two HTTP routes, and either one used to accept
 * any kebab-case slug and persist `s.tools[slug]` — which is how a record with no
 * processor, no route and no capability row reached the public catalog and the
 * counts. The refusal has to live where the write happens.
 *
 * The fake store below records writes so "refused" can be told from "wrote it
 * anyway and returned an error", and the canonical case asserts the CMS still
 * works — a boundary that refuses everything would pass a one-sided test.
 */

const state = vi.hoisted(() => ({ writes: [] as string[] }));

vi.mock("@/data/admin", () => ({
  updateStore: async (mutator: (s: { tools: Record<string, unknown> }) => void) => {
    const draft = { tools: {} as Record<string, unknown> };
    await mutator(draft);
    state.writes.push(...Object.keys(draft.tools));
    return draft;
  },
  readStore: async () => ({ tools: {} }),
  getTools: async () => [],
}));

// A valid session; this test is about identity policy, not authentication.
vi.mock("@/app/api/admin/_guard", () => ({ requireAdmin: async () => null }));

const { POST } = await import("@/app/api/admin/tools/route");
const { PUT, DELETE } = await import("@/app/api/admin/tools/[slug]/route");

function body(slug: string) {
  return {
    slug,
    name: "Anything",
    description: "Anything at all",
    icon: "FileText",
    iconTone: "purple" as const,
    status: "functional-server" as const,
    category: "organize" as const,
    accept: ["application/pdf"],
    multiple: false,
  };
}

const req = (slug: string, method: "POST" | "PUT") =>
  new Request(`http://localhost:3000/api/admin/tools/${slug}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body(slug)),
  });

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("admin tool write boundary", () => {
  beforeEach(() => {
    state.writes = [];
  });

  it("refuses a POST for an unimplemented slug, and writes nothing", async () => {
    const res = await POST(req("invented-tool", "POST"));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(UNKNOWN_TOOL_IDENTITY_ERROR);
    expect(state.writes).toEqual([]);
  });

  it("refuses a PUT for an unimplemented slug — creation by another name", async () => {
    const res = await PUT(req("invented-tool", "PUT"), params("invented-tool"));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(UNKNOWN_TOOL_IDENTITY_ERROR);
    expect(state.writes).toEqual([]);
  });

  it("still stores an editorial override for a canonical tool", async () => {
    const put = await PUT(req("merge-pdf", "PUT"), params("merge-pdf"));
    expect(put.status).toBe(200);
    const post = await POST(req("merge-pdf", "POST"));
    expect(post.status).toBe(200);
    expect(state.writes).toEqual(["merge-pdf", "merge-pdf"]);
  });

  it("still deletes an orphan record, so a leftover is not stranded", async () => {
    const res = await DELETE(
      new Request("http://localhost:3000/api/admin/tools/invented-tool", { method: "DELETE" }),
      params("invented-tool"),
    );
    expect(res.status).toBe(200);
  });
});
