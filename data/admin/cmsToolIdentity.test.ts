import { describe, expect, it, vi } from "vitest";
import path from "path";
import { readFileSync } from "fs";

/**
 * Phase 4 closeout — the CMS may not invent a public tool.
 *
 * The store is a mounted JSON volume with an override entry per tool slug, and
 * the merge used to be `registry UNION store`: any key the store held became a
 * whole tool. One admin edit could therefore
 *
 *   - add a row to the public catalog and to "45 tools",
 *   - claim `functional-server` and land in "32 available" and in the sitemap,
 *   - render an active card whose href 404s, because `generateStaticParams` and
 *     `/tools/[slug]` both answer from the compiled capability registry,
 *   - and be refused by the job API (`assertRemoteJobTool`) if a visitor got
 *     that far.
 *
 * Listing truth, route truth and execution truth disagreed, and a public number
 * moved on a content edit. The merge is now registry-driven, so this file drives
 * it with a hostile store instead of asserting on source text: every assertion
 * below fails if the union comes back.
 *
 * `merge-pdf` carries an editorial override *and* a hostile status in the same
 * record, so "the fix works" and "the CMS still works" cannot both be satisfied
 * by simply ignoring the store.
 */

const HOSTILE_STORE = JSON.stringify({
  tools: {
    // T1/T2/T3 — three invented identities, one per status class, so a leak
    // shows up in whichever count it inflates.
    "invented-tool": {
      slug: "invented-tool",
      name: "Invented",
      description: "Made in the CMS.",
      href: "/tools/invented-tool",
      icon: "FileText",
      iconTone: "purple",
      status: "functional-server",
      category: "organize",
      accept: ["application/pdf"],
      multiple: false,
    },
    "invented-browser-tool": {
      slug: "invented-browser-tool",
      name: "Invented (browser)",
      description: "Also made in the CMS.",
      status: "functional-client",
      category: "edit",
      accept: ["application/pdf"],
    },
    "invented-ai-tool": {
      slug: "invented-ai-tool",
      name: "Invented (AI)",
      description: "Not built either.",
      status: "coming-soon-ai",
      category: "ai",
      accept: ["application/pdf"],
    },
    // T4 + T6 in one record: editorial fields must apply, status must not.
    "merge-pdf": {
      name: "Merge PDF (edited)",
      description: "Editorial copy written in the CMS.",
      status: "planned",
    },
    // T5 — an unbuilt AI tool advertised as a working server tool.
    "chat-with-pdf": { status: "functional-server" },
    // C8 — a store record that tries to move the two WORKFLOW capabilities: give
    // the encrypted-PDF tool an editor, take the Workspace away from a merge, and
    // relabel the output kind and multiplicity while it is there.
    "protect-pdf": {
      status: "functional-client",
      outputKind: "image",
      editorOpenableOutput: true,
      workspaceSaveableOutput: false,
      multiOutput: true,
    },
    "compress-pdf": {
      outputKind: "office-document",
      editorOpenableOutput: false,
      workspaceSaveableOutput: false,
    },
    "pdf-to-jpg": { multiOutput: false, workspaceSaveableOutput: true },
    // Route truth: an override that tries to aim a real card at a dead route.
    "split-pdf": { slug: "invented-tool", href: "/tools/invented-tool" },
  },
  // No route creates a tools tombstone, but the volume is hand-editable: hiding
  // a tool whose route, capability row and job handler all still work would be
  // the same disagreement in the other direction.
  deleted: { tools: ["compress-pdf"] },
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

const INVENTED = ["invented-tool", "invented-browser-tool", "invented-ai-tool"];

async function mergedTools() {
  const { getTools } = await import("@/data/admin");
  return getTools();
}

describe("a CMS record cannot become a public tool", () => {
  it("T1 — cannot move the available / browser / server counts", async () => {
    const [tools, cap] = await Promise.all([
      mergedTools(),
      import("@/lib/tools/capability"),
    ]);
    expect(cap.getAvailableToolCount(tools)).toBe(32);
    expect(cap.getBrowserToolCount(tools)).toBe(18);
    expect(cap.getServerToolCount(tools)).toBe(14);
    expect(cap.getPlannedToolCount(tools)).toBe(5);
    expect(cap.getAiComingSoonCount(tools)).toBe(8);
    expect(cap.getUnavailableToolCount(tools)).toBe(13);
  });

  it("T2 — cannot move the total: 45 stays 45", async () => {
    const tools = await mergedTools();
    expect(tools).toHaveLength(45);
    const { tools: registry } = await import("@/data/tools");
    expect(tools.map((t) => t.slug).sort()).toEqual(registry.map((t) => t.slug).sort());
    // The tombstone must not have taken a working tool out of the inventory.
    expect(tools.some((t) => t.slug === "compress-pdf")).toBe(true);
  });

  it("T3 — cannot become executable: not listed, no capability row, no static route", async () => {
    const [tools, { capabilityForSlug, isCanonicalToolSlug, TOOL_CAPABILITIES }] =
      await Promise.all([mergedTools(), import("@/lib/tools/capability")]);
    for (const slug of INVENTED) {
      expect(tools.some((t) => t.slug === slug)).toBe(false);
      expect(capabilityForSlug(slug)).toBeNull();
      expect(isCanonicalToolSlug(slug)).toBe(false);
      expect(TOOL_CAPABILITIES.some((c) => c.slug === slug)).toBe(false);
    }
  });

  it("T3 — and the job API refuses it, so no surface can claim execution", async () => {
    const { assertRemoteJobTool } = await import("@/lib/tools/executionPolicy");
    for (const slug of INVENTED) {
      expect(() => assertRemoteJobTool(slug)).toThrow();
    }
  });

  it("T4 — an editorial override on a canonical tool still applies", async () => {
    const tools = await mergedTools();
    const merge = tools.find((t) => t.slug === "merge-pdf");
    expect(merge?.name).toBe("Merge PDF (edited)");
    expect(merge?.description).toBe("Editorial copy written in the CMS.");
  });

  it("T5 — cannot promote an unbuilt tool to functional", async () => {
    const tools = await mergedTools();
    expect(tools.find((t) => t.slug === "chat-with-pdf")?.status).toBe("coming-soon-ai");
  });

  it("T6 — cannot demote a working tool to planned", async () => {
    const tools = await mergedTools();
    expect(tools.find((t) => t.slug === "merge-pdf")?.status).toBe("functional-client");
  });

  it("T7 — no card the catalog renders as active can lead to a 404", async () => {
    const [tools, { capabilityForSlug }, { isComingLater }] = await Promise.all([
      mergedTools(),
      import("@/lib/tools/capability"),
      import("@/lib/tools/processingMode"),
    ]);
    // ToolCard links only when the status is not "coming later"; that link is
    // `tool.href`, and `/tools/[slug]` renders a runner only for a capability
    // row. So an active card is honest exactly when href === capability.route.
    const active = tools.filter((t) => !isComingLater(t.status));
    expect(active).toHaveLength(32);
    for (const tool of active) {
      const capability = capabilityForSlug(tool.slug);
      expect(capability, `active card /${tool.slug} has no capability row`).not.toBeNull();
      expect(capability?.available).toBe(true);
      // The hostile store rewrote split-pdf's href to a dead route.
      expect(tool.href).toBe(capability?.route);
    }
  });

  it("T7 — every canonical tool href resolves to a prerendered param", async () => {
    const [tools, { TOOL_CAPABILITIES }] = await Promise.all([
      mergedTools(),
      import("@/lib/tools/capability"),
    ]);
    const params = new Set(TOOL_CAPABILITIES.map((c) => c.slug));
    for (const tool of tools) {
      expect(params.has(tool.href.replace("/tools/", ""))).toBe(true);
    }
  });

  /**
   * C8 — neither workflow capability is CMS-writable.
   *
   * The store can legitimately edit copy. It must not be able to decide whether a
   * result may be opened in the editor or stored in a Workspace, because both
   * answers are enforced by code the store cannot reach: pdf.js on one side, the
   * `%PDF-` signature check and the 415 in both save routes on the other. A store
   * that could flip `editorOpenableOutput` would offer "Open in Editor" over an
   * encrypted PDF; one that could flip `workspaceSaveableOutput` would offer a
   * Save that the route answers 415 to, or hide a Save that works.
   *
   * `TOOL_CAPABILITIES` is derived from the COMPILED registry, so the hostile
   * record above is inert — this drives the merge anyway and reads the result,
   * because "inert by construction" is exactly the claim that stops being true
   * when someone passes the merged list into the capability module.
   */
  it("C8 — cannot change editor eligibility, Workspace eligibility, kind or multiplicity", async () => {
    const [tools, cap] = await Promise.all([mergedTools(), import("@/lib/tools/capability")]);
    // The hostile record really is in the merged list, so this is not vacuous:
    // the editorial fields it carries are the proof the store was read at all.
    expect(tools.some((t) => t.slug === "protect-pdf")).toBe(true);

    const protect = cap.capabilityForSlug("protect-pdf")!;
    expect(protect.outputKind).toBe("pdf");
    expect(protect.editorOpenableOutput).toBe(false);
    expect(protect.workspaceSaveableOutput).toBe(true);
    expect(protect.multiOutput).toBe(false);

    const compress = cap.capabilityForSlug("compress-pdf")!;
    expect(compress.outputKind).toBe("pdf");
    expect(compress.editorOpenableOutput).toBe(true);
    expect(compress.workspaceSaveableOutput).toBe(true);

    const jpg = cap.capabilityForSlug("pdf-to-jpg")!;
    expect(jpg.multiOutput).toBe(true);
    expect(jpg.workspaceSaveableOutput).toBe(false);

    // And the store did not move the counts either — the phase's two numbers.
    expect(cap.TOOL_CAPABILITIES.filter((c) => c.editorOpenableOutput)).toHaveLength(28);
    expect(cap.TOOL_CAPABILITIES.filter((c) => c.workspaceSaveableOutput)).toHaveLength(29);
  });

  it("C8 — cannot change how a result is persisted, either", async () => {
    // Result persistence mode is `processingLifecycle` + `executionLocation`: a
    // browser result is uploaded from the page, a job result is copied
    // storage-to-storage. `protect-pdf` is a server tool and the store said
    // `functional-client`, which would have moved it onto the browser upload path.
    const cap = await import("@/lib/tools/capability");
    const protect = cap.capabilityForSlug("protect-pdf")!;
    expect(protect.implementationState).toBe("functional-server");
    expect(protect.executionLocation).toBe("pdfdadi-server");
    expect(protect.processingLifecycle).toBe("async-job");
    expect(cap.capabilityInventoryProblems()).toEqual([]);
  });

  it("T7 — the prerendered params come from the registry, never from the store", () => {
    // The third gate. `/tools/[slug]` 404s an unknown slug on its own, but a
    // param list built from the merged store would emit a build-time route for a
    // slug nothing implements, and `capabilityForSlug` is the only reason that
    // page would not then render a runner. Keep the param list canonical.
    const route = readFileSync(
      path.join(process.cwd(), "app/(marketing)/tools/[slug]/page.tsx"),
      "utf8",
    );
    const start = route.indexOf("export async function generateStaticParams");
    // Only the function's own body: `generateMetadata` sits directly below it and
    // legitimately reads the merged list for editorial copy.
    const body = route.slice(start, route.indexOf("\n}", start));
    expect(body).toContain("TOOL_CAPABILITIES");
    expect(body).not.toMatch(/getTools|adminRuntime|@\/data\/admin/);
  });

  it("records the leftovers instead of publishing them", async () => {
    const { getOrphanToolRecords } = await import("@/data/admin");
    expect((await getOrphanToolRecords()).map((r) => r.slug).sort()).toEqual(
      [...INVENTED].sort(),
    );
  });
});

/**
 * T8 — SEO. The sitemap is a submitted promise that a URL exists and works, so it
 * is derived from the capability row (availability *and* route), not from the
 * merged record's status. The previous filter matched `tool.status`, which pointed
 * a crawler at `/tools/invented-tool`.
 */
describe("T8 — sitemap and SEO obey the same policy", () => {
  it("lists exactly the available canonical routes", async () => {
    // The sitemap is fed the merged list PLUS an unknown record claiming to be a
    // working server tool. The merge already drops such a record, so handing the
    // real merged list alone would test nothing here: the assertions would hold
    // with the sitemap's own gate deleted. This is the second, independent gate —
    // a submitted URL is a promise that the route exists, so the sitemap answers
    // from the capability row rather than from whatever status it was handed.
    vi.doMock("@/lib/seo/adminRuntime", async () => {
      const { getTools } = await import("@/data/admin");
      return {
        getToolsList: async () => [
          ...(await getTools()),
          {
            slug: "invented-tool",
            name: "Invented",
            description: "Made in the CMS.",
            href: "/tools/invented-tool",
            icon: "FileText",
            iconTone: "purple",
            status: "functional-server",
            category: "organize",
            accept: ["application/pdf"],
            multiple: false,
          },
        ],
        getBlogList: async () => [],
        getSeoSettings: async () => ({ sitemapExcluded: [] as string[] }),
      };
    });
    vi.doMock("@/lib/seo/metadata", () => ({
      getSITE: async () => ({ url: "https://pdfdadi.test" }),
    }));

    const [{ default: sitemap }, { TOOL_CAPABILITIES }] = await Promise.all([
      import("@/app/sitemap"),
      import("@/lib/tools/capability"),
    ]);
    const urls = (await sitemap()).map((e) => String(e.url));
    const toolUrls = urls.filter((u) => u.includes("/tools/"));

    const expected = TOOL_CAPABILITIES.filter((c) => c.available).map(
      (c) => `https://pdfdadi.test${c.route}`,
    );
    expect(toolUrls.sort()).toEqual(expected.sort());
    expect(toolUrls).toHaveLength(32);
    for (const slug of INVENTED) {
      expect(urls.some((u) => u.includes(slug))).toBe(false);
    }
    // Editorial hostility in both directions: the promoted AI tool stays out,
    // the demoted working tool stays in.
    expect(urls).not.toContain("https://pdfdadi.test/tools/chat-with-pdf");
    expect(urls).toContain("https://pdfdadi.test/tools/merge-pdf");
    vi.doUnmock("@/lib/seo/adminRuntime");
    vi.doUnmock("@/lib/seo/metadata");
  });

  it("keeps the capability registry free of any dependency on the CMS", () => {
    // One-directional by design: data/admin imports capability, never the reverse.
    const src = readFileSync(path.join(process.cwd(), "lib/tools/capability.ts"), "utf8");
    expect(src).not.toContain("data/admin");
    expect(src).not.toContain("adminRuntime");
  });
});
