import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_FIELDS,
  PERSISTENCE_DIAGNOSTIC_EVENTS,
  createDiagnostics,
  sanitizeDiagnosticFields,
  type PersistenceDiagnostic,
} from "./diagnostics";

/**
 * The allowlist is a security boundary, so it is tested like one.
 *
 * Everything the persistence layer can see is document content — the scene graph,
 * the file name, extracted text, image data URLs, signature bitmaps. A sanitizer
 * that quietly stopped sanitizing would leave every call site looking exactly the
 * same while shipping user documents into a log, which is why the refusals are
 * asserted directly rather than inferred from the calls that happen to be made
 * today.
 */

describe("the allowlist", () => {
  it("drops every field it does not recognise", () => {
    const out = sanitizeDiagnosticFields({
      documentId: "doc-1",
      scene: { pages: ["everything the user typed"] },
      extractedText: "Confidential: acquisition of…",
      src: "data:image/png;base64,AAAA",
    });
    expect(out).toEqual({ documentId: "doc-1" });
  });

  it("refuses the document name specifically, which is usually the worst string in the file", () => {
    // "Q3 layoffs — final.pdf" earns nothing that documentId does not.
    expect(DIAGNOSTIC_FIELDS).not.toContain("documentName");
    expect(sanitizeDiagnosticFields({ documentName: "Q3 layoffs — final.pdf" })).toEqual({});
  });

  it("refuses a string in a numeric field, so free text cannot ride in on a number's name", () => {
    expect(sanitizeDiagnosticFields({ revision: "the user's note about revision 4" })).toEqual({});
    expect(sanitizeDiagnosticFields({ revision: 4 })).toEqual({ revision: 4 });
  });

  it("drops objects and arrays outright", () => {
    expect(
      sanitizeDiagnosticFields({
        category: { toString: () => "quota_exceeded" },
        reason: ["a", "b"],
        operation: () => "commit",
      }),
    ).toEqual({});
  });

  it("truncates a string too long to be an identifier", () => {
    const out = sanitizeDiagnosticFields({ reason: "x".repeat(500) });
    expect(String(out.reason)).toHaveLength(121);
    expect(String(out.reason).endsWith("…")).toBe(true);
  });

  it("keeps a null, because 'known to be absent' is different from 'not reported'", () => {
    expect(sanitizeDiagnosticFields({ serverVersion: null })).toEqual({ serverVersion: null });
  });

  it("replaces a non-finite number with null rather than serialising NaN", () => {
    expect(sanitizeDiagnosticFields({ durationMs: Number.NaN })).toEqual({ durationMs: null });
    expect(sanitizeDiagnosticFields({ revision: Number.POSITIVE_INFINITY })).toEqual({
      revision: null,
    });
  });

  it("keeps booleans", () => {
    expect(sanitizeDiagnosticFields({ online: false, fellBackToPreviousSnapshot: true })).toEqual({
      online: false,
      fellBackToPreviousSnapshot: true,
    });
  });

  it("enumerates each event name once", () => {
    expect(new Set(PERSISTENCE_DIAGNOSTIC_EVENTS).size).toBe(PERSISTENCE_DIAGNOSTIC_EVENTS.length);
  });
});

describe("emitting", () => {
  function collector() {
    const seen: PersistenceDiagnostic[] = [];
    return { seen, sink: (diagnostic: PersistenceDiagnostic) => seen.push(diagnostic) };
  }

  it("sanitizes on the way to the sink, not only on the way to history", () => {
    const { seen, sink } = collector();
    const diagnostics = createDiagnostics({ sink, now: () => 500 });
    diagnostics.emit("local_write_succeeded", { revision: 4, extractedText: "secret" });
    expect(seen).toEqual([
      { event: "local_write_succeeded", at: 500, fields: { revision: 4 } },
    ]);
  });

  it("emits nothing at all when disabled", () => {
    const { seen, sink } = collector();
    const diagnostics = createDiagnostics({ sink, enabled: false });
    diagnostics.emit("quota_exceeded", { revision: 1 });
    expect(seen).toHaveLength(0);
    expect(diagnostics.history()).toHaveLength(0);
    expect(diagnostics.enabled).toBe(false);
  });

  it("stops after the cap, so a retry loop cannot generate its own traffic", () => {
    const { seen, sink } = collector();
    const diagnostics = createDiagnostics({ sink, maxEvents: 3, now: () => 1 });
    for (let i = 0; i < 10; i += 1) diagnostics.emit("local_write_failed", { retryCount: i });
    expect(seen).toHaveLength(3);
  });

  it("reports the truncation as its own event rather than borrowing another one's name", () => {
    /*
     * The truncation notice used to be emitted as `stale_response_ignored` with a
     * distinguishing `reason`. Anyone counting stale responses — the metric that
     * exists to prove a race is happening — would have counted diagnostics
     * overflow as evidence of one.
     */
    const diagnostics = createDiagnostics({ maxEvents: 2, now: () => 7 });
    for (let i = 0; i < 5; i += 1) diagnostics.emit("local_write_failed", { retryCount: i });
    const history = diagnostics.history();
    expect(history).toHaveLength(3);
    const last = history[history.length - 1]!;
    expect(last.event).toBe("diagnostics_truncated");
    expect(last.fields.reason).toBeUndefined();
    expect(last.fields.staleCount).toBeUndefined();
    expect(last.fields.droppedCount).toBe(3);
    expect(history.filter((entry) => entry.event === "stale_response_ignored")).toHaveLength(0);
  });

  it("does not append a truncation notice when nothing was dropped", () => {
    const diagnostics = createDiagnostics({ maxEvents: 5, now: () => 7 });
    diagnostics.emit("draft_found", { generation: 2 });
    expect(diagnostics.history()).toHaveLength(1);
  });
});
