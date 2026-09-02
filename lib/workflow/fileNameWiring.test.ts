import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T1 wiring — the filename policy has no competitors left.
 *
 * `fileNames.test.ts` proves the policy. It proves nothing about whether the
 * product uses it, which is exactly the shape of the original defect: the rules
 * were fine in each of the three places that had their own copy, and
 * `probe-document-merged (1)-merged.pdf` came from them not knowing about each
 * other. So this file asserts the absence of the composition sites, on source,
 * because every one of them lives in a React component or a Node worker that this
 * pure suite cannot execute.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** Comments removed: a comment *documenting* a removed pattern is not a copy of it. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const processor = stripComments(read("hooks", "usePdfProcessor.ts"));
const serverTools = stripComments(read("lib", "server", "toolProcessing.ts"));
const jobHandler = stripComments(read("src", "infrastructure", "jobs", "ProcessingJobHandler.ts"));
const editor = stripComments(read("components", "editor", "EditorWorkspace.tsx"));
const shell = stripComments(read("components", "editor", "StandaloneEditorShell.tsx"));

describe("every generated name comes from lib/workflow/fileNames", () => {
  it("the local tool hook composes through the policy, not by hand", () => {
    expect(processor).toContain('from "@/lib/workflow/fileNames"');
    expect(processor).toContain("outputFileName(");
    // The old body: base + "-" + suffix + ext, assembled here.
    expect(processor).not.toMatch(/`\$\{base\}-\$\{suffix\}\$\{ext\}`/);
  });

  it("no server processor interpolates ctx.baseName into a name", () => {
    expect(serverTools).toContain('from "@/lib/workflow/fileNames"');
    // Twelve sites used to read `${ctx.baseName}-<suffix>.<ext>`.
    expect(serverTools).not.toMatch(/`\$\{ctx\.baseName\}/);
  });

  it("the job handler derives its base from the shared policy", () => {
    expect(jobHandler).toContain("baseNameOf(");
    // The old sanitizer turned a download-folder `(1)` into `_1_`.
    expect(jobHandler).not.toMatch(/\[\^\\w\.-\]\+/);
  });

  it("the editor's export and local copy names come from the policy", () => {
    expect(editor).toContain('from "@/lib/workflow/fileNames"');
    expect(editor).not.toMatch(/`\$\{fileName\}-edited\.pdf`/);
    expect(editor).not.toMatch(/`\$\{fileName\}-local-copy\.pdf`/);
  });

  it("the Workspace save name is built from the document name, not the display title", () => {
    expect(shell).toContain("outputFileName(");
    // `${title}.pdf` is how "Untitled PDF" became `Untitled PDF.pdf`.
    expect(shell).not.toMatch(/`\$\{title\}\.pdf`/);
  });

  it("a multi-input runner hands the policy every source name", () => {
    // Naming a merge after `upload.files[0]` alone is what made the count
    // strategy (`a-and-9-more`) unreachable in the product.
    for (const runner of ["MergeTool.tsx", "JpgToPdfTool.tsx"]) {
      const source = stripComments(read("components", "tools", "runners", runner));
      expect(source, runner).not.toContain(", upload.files[0])");
    }
  });
});
