import { describe, expect, it, vi } from "vitest";
import path from "path";
import { readFileSync } from "fs";

/**
 * T17 — the CMS may not decide what this repository implements.
 *
 * The admin store can override any field of any tool, and the tool editor used to
 * expose `status` as a plain select. A hostile or merely optimistic edit —
 * `chat-with-pdf` → `functional-server` — reached three public surfaces at once:
 * the catalog badge said "Available now", the derived counts included it, and the
 * dynamic tool route rendered a real upload form for a slug with no processor.
 * The job API would still have refused the submission (`assertRemoteJobTool`), so
 * the failure mode was not fabricated success — it was a form whose only possible
 * outcome is an error, which is the same lie one step later.
 *
 * The merge now takes `status` from the compiled registry for every tool the
 * registry knows, and this test drives that merge with a hostile store rather
 * than reading the source line that implements it. Editorial fields must still
 * override, or the fix has quietly disabled the CMS.
 */

const HOSTILE_STORE = JSON.stringify({
  tools: {
    // Advertise an unbuilt AI tool as a working server tool, and rename it.
    "chat-with-pdf": { status: "functional-server", name: "Chat with PDF (live!)" },
    // Demote a tool that works, as an operator might try to "take it offline".
    "merge-pdf": { status: "planned" },
    // A tool the admin invented. No registry row, so its own status is all there is.
    "invented-tool": {
      slug: "invented-tool",
      name: "Invented",
      description: "Made in the CMS.",
      status: "functional-server",
      category: "organize",
      icon: "FileText",
      accept: ["application/pdf"],
    },
  },
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(async (file: string, ...rest: unknown[]) =>
        String(file).endsWith(path.join("data", "admin", "store.json"))
          ? HOSTILE_STORE
          : (actual.promises.readFile as (...a: unknown[]) => Promise<string>)(file, ...rest),
      ),
    },
  };
});

const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("admin overrides cannot rewrite implementation state", () => {
  it("keeps the registry status while still applying editorial overrides", async () => {
    const { getTools } = await import("@/data/admin");
    const merged = await getTools();

    const chat = merged.find((t) => t.slug === "chat-with-pdf");
    expect(chat?.status).toBe("coming-soon-ai");
    // The rename is editorial and must survive, or this fix broke the CMS.
    expect(chat?.name).toBe("Chat with PDF (live!)");

    expect(merged.find((t) => t.slug === "merge-pdf")?.status).toBe("functional-client");
  });

  it("drops an admin-created tool from the public inventory entirely", async () => {
    const [{ getTools, getOrphanToolRecords }, { capabilityForSlug }] =
      await Promise.all([import("@/data/admin"), import("@/lib/tools/capability")]);
    const merged = await getTools();
    // Was the last hole: a CMS-invented tool had no compiled status to defer to,
    // so its own `status` made it public and countable while its route 404d.
    // The merge is now registry-driven, so the record is inert — and visible to
    // an operator only through the orphan listing.
    expect(merged.some((t) => t.slug === "invented-tool")).toBe(false);
    expect(capabilityForSlug("invented-tool")).toBeNull();
    expect((await getOrphanToolRecords()).map((r) => r.slug)).toEqual(["invented-tool"]);
  });

  it("branches the dynamic tool route on the capability, not the merged record", () => {
    const route = src("app/(marketing)/tools/[slug]/page.tsx");
    expect(route).toContain("const capability = capabilityForSlug(slug)");
    for (const state of ["functional-client", "functional-server", "coming-soon-ai"]) {
      expect(route).toContain(`capability.implementationState === "${state}"`);
    }
    // No branch may be taken on the merged status.
    expect(route).not.toMatch(/tool\.status/);
  });

  it("offers no editable status control at all in the tools manager", () => {
    const manager = src("components/admin/ToolsManager.tsx");
    expect(manager).toContain("Set by the code that implements this tool.");
    // Every tool the manager lists is one the code implements, so the old
    // conditional select (kept for CMS-invented tools) has no case left to serve.
    expect(manager).not.toMatch(/onChange=\{\(e\) => patch\("status"/);
  });
});
