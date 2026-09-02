import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_NAME,
  sanitizeDocumentName,
  shouldCommitRename,
} from "@/components/editor/appBarLogic";

/**
 * What is left of this file, and what left it.
 *
 * It used to open with a `saveIndicator` honesty contract — a second projection of
 * the save state, derived from the last completed EXPORT. That function is gone,
 * and so are its tests: the app bar renders the canonical `SaveStatusView` now, and
 * the honesty contract it was asserting lives where the projection does
 * (`derivedStatus.test.ts`, plus `saveStateAgreement.test.ts` for the rule that no
 * two surfaces may disagree). Keeping both would have meant testing that a retired
 * model still behaved.
 *
 * The name rules stayed here, because they were never about persistence.
 */

/**
 * `fileName` becomes an export filename (`${fileName}-edited.pdf`), so a rename
 * field is an untrusted string reaching a filesystem-adjacent position. These
 * are the adversarial cases.
 */
describe("appBarLogic — sanitizeDocumentName", () => {
  it("keeps ordinary names intact", () => {
    expect(sanitizeDocumentName("Business Proposal")).toBe("Business Proposal");
    expect(sanitizeDocumentName("Q3 report (final)")).toBe("Q3 report (final)");
    expect(sanitizeDocumentName("  padded  name  ")).toBe("padded name");
  });

  it("strips path separators so a name cannot redirect the download", () => {
    expect(sanitizeDocumentName("../../etc/passwd")).toBe("etc passwd");
    expect(sanitizeDocumentName("..\\..\\windows\\system32")).toBe("windows system32");
    expect(sanitizeDocumentName("/absolute/path")).toBe("absolute path");
    for (const out of [
      sanitizeDocumentName("../../etc/passwd"),
      sanitizeDocumentName("..\\..\\win"),
      sanitizeDocumentName("a/b\\c"),
    ]) {
      expect(out).not.toMatch(/[/\\]/);
      expect(out).not.toMatch(/\.\./);
    }
  });

  it("removes characters the platform forbids in filenames", () => {
    const out = sanitizeDocumentName('re<port>:"x"|y?z*');
    expect(out).not.toMatch(/[<>:"|?*]/);
    expect(out).toBeTruthy();
  });

  it("removes control characters", () => {
    const raw = `re${String.fromCharCode(0)}port${String.fromCharCode(9)}x${String.fromCharCode(127)}`;
    const out = sanitizeDocumentName(raw);
    expect(out).toBeTruthy();
    expect([...(out as string)].every((c) => c.codePointAt(0)! >= 32 && c.codePointAt(0)! !== 127)).toBe(
      true,
    );
  });

  it("refuses names that carry no information", () => {
    expect(sanitizeDocumentName("")).toBeNull();
    expect(sanitizeDocumentName("    ")).toBeNull();
    expect(sanitizeDocumentName("...")).toBeNull();
    expect(sanitizeDocumentName("///")).toBeNull();
    expect(sanitizeDocumentName(String.fromCharCode(0))).toBeNull();
  });

  it("does not produce a hidden file or a Windows-dropped trailing dot", () => {
    expect(sanitizeDocumentName(".hidden")).toBe("hidden");
    expect(sanitizeDocumentName("report.")).toBe("report");
    expect(sanitizeDocumentName("report ")).toBe("report");
  });

  it("bounds the length so the download name cannot blow a path limit", () => {
    const out = sanitizeDocumentName("a".repeat(500));
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(MAX_DOCUMENT_NAME);
  });

  it("suffixes Windows reserved device names instead of failing the save", () => {
    // "Aux" and "Con" are legitimate prose; silently failing to download would
    // be worse than a slightly adjusted name.
    expect(sanitizeDocumentName("NUL")).toBe("NUL-doc");
    expect(sanitizeDocumentName("com1")).toBe("com1-doc");
    expect(sanitizeDocumentName("Aux")).toBe("Aux-doc");
    // But a reserved word inside a longer name is fine.
    expect(sanitizeDocumentName("Aux notes")).toBe("Aux notes");
  });
});

describe("appBarLogic — shouldCommitRename", () => {
  it("does not commit a no-op or an unusable rename", () => {
    expect(shouldCommitRename("report", "report")).toBe(false);
    // Sanitises to the same value, so still a no-op.
    expect(shouldCommitRename("report", "  report  ")).toBe(false);
    expect(shouldCommitRename("report", "")).toBe(false);
    expect(shouldCommitRename("report", "   ")).toBe(false);
    expect(shouldCommitRename("report", "...")).toBe(false);
  });

  it("commits a genuine change", () => {
    expect(shouldCommitRename("report", "Report v2")).toBe(true);
    expect(shouldCommitRename("Untitled PDF", "Contract")).toBe(true);
  });
});
