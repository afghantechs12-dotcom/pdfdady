import { describe, expect, it } from "vitest";
import { TOOL_CAPABILITIES, capabilityForSlug } from "@/lib/tools/capability";
import {
  PILOT_TOOL_SLUG,
  isProcessingPipelineEnabled,
} from "@/lib/server/processingPilot";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentDisposition,
  contentDisposition,
  preparationFromIngestion,
  resolveDocumentContent,
} from "@/src/application/services/documentContent";
import type { DocumentVersion, DocumentVersionManifest } from "@/src/domain/entities/DocumentVersion";
import { LocalFileStorage } from "@/src/infrastructure/storage/LocalFileStorage";
import { sanitizeBaseName } from "@/lib/server/toolJobSubmit";
import { UploadValidationError, validateUpload } from "@/lib/server/validateUpload";
import {
  MalformedMultipartError,
  multipartFailure,
  readMultipart,
} from "@/lib/server/multipart";
import { serverToolConfig } from "@/data/serverToolConfig";
import { clearedSessionCookieOptions, sessionCookieOptions } from "@/src/application/services/authHttp";
import { mapWorkspaceError } from "@/src/application/services/workspaceHttp";
import { sanitizeEventProperties } from "@/src/domain/metering/events";
import { pricingPlans } from "@/data/pricing";
import { isPurchasablePlanId } from "@/src/domain/billing/subscription";
import { outputFileName } from "@/lib/workflow/fileNames";
import {
  awaitingDestinationChoice,
  classifyResultSaveFailure,
  resolveInitialSelection,
  resultSaveFailureMessage,
  resultWorkflowActions,
} from "@/components/tools/resultWorkflow";

/**
 * R1..R30 — the behavioural regressions the final pre-launch audit leaves behind.
 *
 * One rule decided what is in here: every assertion CALLS the thing it is about.
 * The audit's own harness found ten of its own checks matching text that only
 * looked like the behaviour, and this repository has a longer history of the same
 * failure — a green wiring test that pinned the guard which killed autosave, 26
 * green policy tests over a consumer that called itself in an infinite loop. So
 * none of these reads source, and none asserts a shape a mock invented.
 *
 * They are numbered because the audit report cites them by number. Facts already
 * covered by a test written earlier in this audit are NOT repeated here — the
 * production gate lives in `src/infrastructure/config/env.test.ts`, the legacy
 * save route in `app/api/jobs/saveToWorkspaceRoute.test.ts`, the image in
 * `deploymentArtifact.test.ts`, the shipped admin store in
 * `data/admin/shippedStoreSecrets.test.ts` and the proxy origin in
 * `src/application/services/workspaceCsrfProxyOrigin.test.ts`.
 *
 * Most of these pin something no other test in the suite calls at all. Six do not,
 * and say so rather than being presented as new coverage: R13..R18 re-derive the
 * content-availability table that `documentContent.test.ts` also covers, R24 the
 * event allowlist in `src/domain/metering/events.test.ts`, and R25 the plan copy in
 * `data/pricing.test.ts`. They are kept because the audit's conclusions rest on
 * them directly and an audit that cites another file's assertions has not checked
 * anything itself.
 */

/* ===================== The pilot flag, and what ships ===================== */

describe("R1..R3 the shipped default job shape", () => {
  const clearOverride = () => {
    delete (process.env as Record<string, string | undefined>).PROCESSING_PIPELINE;
  };

  it("R1 defaults every tool to the legacy path — no flag, no pipeline", async () => {
    clearOverride();
    // The DI container is not booted in a unit run, so the flag lookup throws and
    // the function's own catch decides. That IS the deployment case being
    // asserted: an unreachable flag store must resolve to the path already
    // running in production, not to the pilot.
    for (const capability of TOOL_CAPABILITIES) {
      expect(await isProcessingPipelineEnabled(capability.slug)).toBe(false);
    }
  });

  it("R2 an operator turning the pilot ON moves exactly one tool", async () => {
    (process.env as Record<string, string | undefined>).PROCESSING_PIPELINE = "on";
    try {
      expect(await isProcessingPipelineEnabled(PILOT_TOOL_SLUG)).toBe(true);
      const swept = [];
      for (const capability of TOOL_CAPABILITIES) {
        if (capability.slug === PILOT_TOOL_SLUG) continue;
        if (await isProcessingPipelineEnabled(capability.slug)) swept.push(capability.slug);
      }
      expect(swept).toEqual([]);
    } finally {
      clearOverride();
    }
  });

  it("R3 every save-offering tool therefore produces a legacy job by default", async () => {
    // Why the P1 defect was invisible for a phase: the button is offered on these
    // tools, and in the shipped configuration every one of them submits a
    // `pdf-tool` job. A save route that handles only `processing` jobs answers 404
    // to all of them. `saveToWorkspaceRoute.test.ts` holds the route's side.
    clearOverride();
    const saveable = TOOL_CAPABILITIES.filter((c) => c.workspaceSaveableOutput);
    expect(saveable.length).toBeGreaterThan(1);
    for (const capability of saveable) {
      expect(await isProcessingPipelineEnabled(capability.slug)).toBe(false);
    }
  });
});

/* ============ What a finished result offers, and what it must not ========= */

const EDITABLE_AND_SAVEABLE = { editorOpenableOutput: true, workspaceSaveableOutput: true };

describe("R4..R8 the two result actions", () => {
  it("R4 no tool whose output is not a PDF claims either action", () => {
    const wrong = TOOL_CAPABILITIES.filter(
      (c) => c.outputKind !== "pdf" && (c.editorOpenableOutput || c.workspaceSaveableOutput),
    ).map((c) => `${c.slug}:${c.outputKind}`);
    // An archive of JPEGs and a .docx are not documents the editor opens or the
    // Workspace stores as one document. Both save routes answer 415 for them, so
    // an offered button here would be one that cannot succeed.
    expect(wrong).toEqual([]);
  });

  it("R5 a run that REPORTED a non-PDF output overrides the capability", () => {
    const base = { capability: EDITABLE_AND_SAVEABLE, resultAvailable: true, destination: "ready" as const };
    expect(resultWorkflowActions({ ...base, outputMimeType: "application/pdf" })).toEqual({
      openInEditor: true,
      saveToWorkspace: true,
      signInToSave: false,
    });
    // The capability describes the tool; the MIME describes the bytes on screen.
    // This is the branch journey I' of the Phase 5 probe cannot reach with the
    // pipeline off, because its interception hook rewrites a fetch frame and the
    // legacy runner reads its status over EventSource.
    expect(resultWorkflowActions({ ...base, outputMimeType: "image/jpeg" })).toEqual({
      openInEditor: false,
      saveToWorkspace: false,
      signInToSave: false,
    });
    expect(resultWorkflowActions({ ...base, outputMimeType: "application/zip" }).saveToWorkspace).toBe(false);
  });

  it("R6 an expired result offers nothing — both actions need the bytes", () => {
    const actions = resultWorkflowActions({
      capability: EDITABLE_AND_SAVEABLE,
      outputMimeType: null,
      resultAvailable: false,
      destination: "ready",
    });
    expect(actions).toEqual({ openInEditor: false, saveToWorkspace: false, signInToSave: false });
  });

  it("R7 a signed-out user is offered sign-in, never a save", () => {
    const guest = resultWorkflowActions({
      capability: EDITABLE_AND_SAVEABLE,
      outputMimeType: null,
      resultAvailable: true,
      destination: "guest",
    });
    expect(guest.saveToWorkspace).toBe(false);
    expect(guest.signInToSave).toBe(true);
    // And the local action still works: a browser result reaches the editor
    // through this browser's own storage, so signing in is not a precondition.
    expect(guest.openInEditor).toBe(true);
  });

  it("R8 several Workspaces hold Save inert until one is chosen", () => {
    const input = {
      capability: EDITABLE_AND_SAVEABLE,
      outputMimeType: null,
      resultAvailable: true,
      destination: "choose" as const,
    };
    expect(resultWorkflowActions(input).saveToWorkspace).toBe(false);
    expect(awaitingDestinationChoice(input)).toBe(true);
    // And the selector never appears on a result that could not be saved at all.
    expect(awaitingDestinationChoice({ ...input, resultAvailable: false })).toBe(false);
    expect(awaitingDestinationChoice({ ...input, outputMimeType: "image/jpeg" })).toBe(false);
    const one = [{ workspaceId: "w1", organizationId: "o1", workspaceName: "Only" }];
    expect(resolveInitialSelection(one)).toBe("w1");
    expect(resolveInitialSelection([...one, { workspaceId: "w2", organizationId: "o1", workspaceName: "Second" }])).toBeNull();
  });
});

/* =================== Names that travel, and keys that do not ============== */

describe("R9..R12 hostile names and storage keys", () => {
  it("R9 a filename cannot inject a header", () => {
    for (const hostile of [
      `report${String.fromCharCode(13, 10)}X-Injected: yes.pdf`,
      'a"; filename="b.pdf',
      String.fromCharCode(0, 1, 2),
      "réport.pdf",
      "a;b.pdf",
    ]) {
      const header = attachmentDisposition(hostile);
      // Neither form can end the header, the quoted string, or the parameter list
      // early: exactly one pair of quotes and exactly two `;` separators survive,
      // and no raw control character reaches the wire in either form.
      expect(header).not.toMatch(/[\x00-\x1f]/);
      expect(header.match(/"/g)?.length).toBe(2);
      expect(header.split(";")).toHaveLength(3);
      expect(header.startsWith("attachment; filename=")).toBe(true);
    }
    // The real name still travels, for a client that can read it.
    expect(attachmentDisposition("réport.pdf")).toContain("filename*=UTF-8''r%C3%A9port.pdf");
    // And the ASCII fallback is never empty: a name with nothing usable left in it
    // still names something, rather than emitting `filename=""`.
    expect(attachmentDisposition("   ")).toContain('filename="document"');
  });

  it("R10 a download is named once, with one extension", () => {
    expect(contentDisposition("attachment", "quarterly")).toContain('filename="quarterly.pdf"');
    expect(contentDisposition("attachment", "quarterly.pdf")).toContain('filename="quarterly.pdf"');
    expect(contentDisposition("attachment", "quarterly.PDF")).not.toContain(".PDF.pdf");
    // Inline is inline: no name is disclosed for a render the editor performs.
    expect(contentDisposition("inline", "secret-name.pdf")).toBe("inline");
  });

  it("R11 an upload name reaches the filesystem as one path segment", () => {
    for (const hostile of [
      "../../etc/passwd.pdf",
      "..\\..\\windows\\system32.pdf",
      `a${String.fromCharCode(0)}b.pdf`,
      `line${String.fromCharCode(13, 10)}break.pdf`,
      "  .pdf",
      "%2e%2e%2fetc.pdf",
      "..",
    ]) {
      const base = sanitizeBaseName(hostile);
      expect(base).not.toContain("/");
      expect(base).not.toContain("\\");
      expect(base).not.toMatch(/[\x00-\x1f]/);
      expect(base.length).toBeGreaterThan(0);
      expect(base.length).toBeLessThanOrEqual(80);
    }
    /*
     * A dot-only name used to survive AS a dot segment — `..` came back `..`, and
     * `..pdf` came back `..`. Nothing escaped, because the intake gate requires an
     * extension from the tool's own allowlist and the storage guard refuses a
     * traversal — but the sanitizer's contract is "a name", and `..` is not one:
     * it reached the user as a download called `...pdf`. Now it takes the same
     * fallback the empty string does. Both halves are still asserted, because the
     * gate is what makes ANY residue inert and it must not quietly go away.
     */
    for (const dots of ["..", ".", "...", "..pdf"]) {
      expect(sanitizeBaseName(dots), `${dots} must not survive as a path segment`).toBe(
        "document",
      );
    }
    for (const [slug, config] of Object.entries(serverToolConfig)) {
      expect(config.extensions.length, slug).toBeGreaterThan(0);
      for (const ext of config.extensions) expect(ext, slug).toMatch(/^\.[a-z0-9]+$/);
    }
  });

  it("R11b a name with no allowed extension never reaches staging", async () => {
    const config = serverToolConfig["compress-pdf"];
    const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
    await expect(
      validateUpload(new File([pdfBytes], "..", { type: "application/pdf" }), config),
    ).rejects.toThrow(UploadValidationError);
    // The nearest name that IS accepted still carries an extension the allowlist
    // named — and its dot-only base now becomes the fallback, so the composed name
    // is a name at both layers rather than only at the gate.
    const accepted = await validateUpload(
      new File([pdfBytes], "...pdf", { type: "application/pdf" }),
      config,
    );
    expect(accepted.ext).toBe(".pdf");
    expect(accepted.originalName).toBe("...pdf");
    expect(`${sanitizeBaseName(accepted.originalName)}${accepted.ext}`).toBe("document.pdf");
  });

  it("R12 a key that escapes the storage root is refused, at the store", async () => {
    const root = mkdtempSync(join(tmpdir(), "audit-storage-"));
    try {
      const storage = new LocalFileStorage(root);
      await storage.put("tool-inputs/abc/document.pdf", Buffer.from("%PDF-1.7\n"), {
        contentType: "application/pdf",
      });
      expect((await storage.get("tool-inputs/abc/document.pdf")).toString()).toContain("%PDF");
      for (const escaping of ["../outside.pdf", "tool-inputs/../../outside.pdf", "/etc/passwd"]) {
        await expect(storage.head(escaping)).rejects.toThrow(/escapes root/);
      }
      /*
       * The composed production key for R11's worst accepted name. The staging site
       * builds `tool-inputs/<uuid>/<base><ext>`, and `head` reading it back proves
       * the bytes landed under the root at the path the key named. The base is now
       * `document` rather than `..`, which is the point of the R11 fix — this line
       * composes it rather than hard-coding it, so it follows the sanitizer.
       */
      const dotKey = `tool-inputs/11111111-2222-3333-4444-555555555555/${sanitizeBaseName("...pdf")}.pdf`;
      await storage.put(dotKey, Buffer.from("%PDF-1.7\n"), { contentType: "application/pdf" });
      expect((await storage.head(dotKey)).size).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ============== Bytes a document has, and bytes it does not yet =========== */

const manifest = (over: Partial<DocumentVersionManifest> = {}): DocumentVersionManifest => ({
  schema: 1,
  sourceKey: "ab/cd/ef/abcdef",
  sourceChecksum: "abcdef",
  sourceByteSize: 3433,
  editorStateKey: null,
  editorStateChecksum: null,
  outputKey: null,
  outputChecksum: null,
  pageCount: null,
  thumbnailKeys: [],
  ...over,
});

const version = (over: Partial<DocumentVersion> = {}): DocumentVersion => ({
  id: "v1",
  workspaceId: "w1",
  organizationId: "o1",
  documentId: "d1",
  versionNumber: 1,
  revision: 1,
  origin: "import",
  restoredFromVersionId: null,
  label: null,
  manifest: manifest(),
  manifestDegraded: false,
  checksum: "deadbeef",
  createdById: "u1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("R13..R18 content availability", () => {
  it("R13 a document with no version answers 409, not an empty PDF", () => {
    const resolution = resolveDocumentContent({ documentId: "d1", version: null });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.status).toBe(409);
      expect(resolution.message).not.toContain("/");
    }
  });

  it("R14 a version belonging to another document is not found, not forbidden", () => {
    const resolution = resolveDocumentContent({ documentId: "d1", version: version({ documentId: "d2" }) });
    expect(resolution.ok).toBe(false);
    // 404 rather than 403: the distinction would itself disclose that the version
    // exists somewhere else.
    if (!resolution.ok) expect(resolution.status).toBe(404);
  });

  it("R15 a manifest that could not be read reliably serves nothing", () => {
    const resolution = resolveDocumentContent({ documentId: "d1", version: version({ manifestDegraded: true }) });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.status).toBe(409);
  });

  it("R16 a version with no usable source artifact serves nothing", () => {
    for (const broken of [manifest({ sourceKey: "" }), manifest({ sourceByteSize: 0 }), manifest({ sourceByteSize: -1 })]) {
      const resolution = resolveDocumentContent({ documentId: "d1", version: version({ manifest: broken }) });
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) expect(resolution.status).toBe(409);
    }
  });

  it("R17 auto prefers the materialized output; source is asked for by name", () => {
    const edited = version({ manifest: manifest({ outputKey: "out/1", outputChecksum: "cafe" }) });
    const auto = resolveDocumentContent({ documentId: "d1", version: edited });
    expect(auto.ok && auto.artifact).toBe("output");
    expect(auto.ok && auto.sourceKey).toBe("out/1");
    // No recorded length for an output: the caller heads the store rather than
    // quoting the SOURCE's length, which would truncate the download.
    expect(auto.ok && auto.byteSize).toBeNull();
    const source = resolveDocumentContent({ documentId: "d1", version: edited, artifact: "source" });
    expect(source.ok && source.sourceKey).toBe("ab/cd/ef/abcdef");
    expect(source.ok && source.byteSize).toBe(3433);
  });

  it("R18 a save that has not been ingested yet is waitable, and says so", () => {
    // The product's side of the Phase 5 probe's N3 race: `uploadToWorkspace`
    // returns 201 with the ingestion `pending`, the worker cuts version 1, and
    // until it does the content route answers 409 with a preparation state the
    // client can act on. "processing" is worth waiting for; "none" is not.
    expect(preparationFromIngestion("pending")).toBe("processing");
    expect(preparationFromIngestion("processing")).toBe("processing");
    expect(preparationFromIngestion("failed")).toBe("failed");
    expect(preparationFromIngestion("complete")).toBe("none");
    expect(preparationFromIngestion(null)).toBe("none");
  });
});

/* ============= What the intake refuses before a binary ever runs ========== */

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

describe("R19..R20 upload intake", () => {
  it("R19 a claimed extension is checked against the actual leading bytes", async () => {
    const pdfTool = serverToolConfig["compress-pdf"];
    // The defence that matters: the file is handed to Ghostscript/LibreOffice, and
    // both the extension and the browser's MIME are attacker-chosen.
    for (const impostor of [
      Buffer.from("<html><body>not a pdf</body></html>"),
      ZIP_BYTES,
      Buffer.from("GIF89a"),
      Buffer.from(""),
    ]) {
      await expect(
        validateUpload(new File([impostor], "invoice.pdf", { type: "application/pdf" }), pdfTool),
      ).rejects.toThrow(UploadValidationError);
    }
    // And the genuine article is accepted, so the check is a filter, not a wall.
    const ok = await validateUpload(
      new File([PDF_BYTES], "invoice.pdf", { type: "application/pdf" }),
      pdfTool,
    );
    expect(ok.mimeType).toBe("application/pdf");
    expect(ok.size).toBe(PDF_BYTES.byteLength);

    // A ZIP-container tool refuses a PDF under a .docx name, for the same reason.
    const wordTool = Object.values(serverToolConfig).find((c) => c.extensions.includes(".docx"));
    if (wordTool) {
      await expect(
        validateUpload(new File([PDF_BYTES], "notes.docx", { type: wordTool.accept[0] }), wordTool),
      ).rejects.toThrow(UploadValidationError);
      await expect(
        validateUpload(new File([ZIP_BYTES], "notes.docx", { type: wordTool.accept[0] }), wordTool),
      ).resolves.toMatchObject({ ext: ".docx" });
    }
  });

  it("R19b a body no multipart parser can read is the caller's error, not a 500", async () => {
    // Found by a runtime probe, not by reading: a filename containing a raw `"`
    // makes the Content-Disposition header ambiguous, undici's parser throws
    // `TypeError: Failed to parse body as FormData.`, and before the guard that
    // fell through to the submit route's generic catch — an UNLOGGED 500 for what
    // is entirely the caller's malformed request. The Workspace upload routes
    // already answered 400 for the same input; the tool routes did not.
    const hostile = '"><img src=x onerror=alert(1)>../../../etc/passwd.pdf';
    const body =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="${hostile}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--X--\r\n`;
    const request = () =>
      new Request("http://x/api/jobs?slug=compress-pdf", {
        method: "POST",
        body,
        headers: { "content-type": "multipart/form-data; boundary=X" },
      });

    // 1. The guard is REACHABLE: the parser really does reject this body. Without
    //    this the try/catch could be dead code and the test would still pass.
    await expect(request().formData()).rejects.toThrow(TypeError);

    // 2. A spec-conforming client is unaffected, which is why no browser hit it:
    //    the same name round-trips as `%22` and parses back byte-for-byte.
    const spec = new FormData();
    spec.append("file", new File([PDF_BYTES], hostile, { type: "application/pdf" }));
    const encoded = new Request("http://x/", { method: "POST", body: spec });
    const raw = await encoded.text();
    expect(raw).toContain('filename="%22><img src=x onerror=alert(1)>../../../etc/passwd.pdf"');
    const reparsed = await new Request("http://x/", {
      method: "POST",
      body: raw,
      headers: { "content-type": encoded.headers.get("content-type")! },
    }).formData();
    expect((reparsed.get("file") as File).name).toBe(hostile);

    // 3. The shared reader BOTH submit paths now call — and all three Workspace
    //    upload routes with them — turns that failure into the 400 taxonomy.
    //    Exercised rather than read: invoking a submit path itself would stand up
    //    Prisma, storage and a worker (see meteringSubmitWiring.test.ts), but the
    //    reader is the whole of the behaviour under test. The 400 as a live HTTP
    //    answer is measured in
    //    docs/evidence/final-prelaunch/hostile-filename-r13.log.
    await expect(readMultipart(request(), 110 * 1024 * 1024)).rejects.toThrow(
      MalformedMultipartError,
    );
    expect(multipartFailure(new MalformedMultipartError())).toMatchObject({
      status: 400,
      code: "MALFORMED_MULTIPART",
    });

    // 4. The NEGATIVE form, which is what makes this a guard rather than a wall:
    //    the same hostile name, encoded the way a conforming client encodes it,
    //    still parses through the same reader and arrives with its name intact.
    const parsed = await readMultipart(
      new Request("http://x/", {
        method: "POST",
        body: raw,
        headers: { "content-type": encoded.headers.get("content-type")! },
      }),
      110 * 1024 * 1024,
    );
    expect((parsed.get("file") as File).name).toBe(hostile);

    // The inventory — that NO other shipped code reads a multipart body — is S1 in
    // uploadBoundary.test.ts, which is where the absence of a sibling call site can
    // be asserted as an absence.
  });

  it("R20 the intake's four ceilings are enforced where the file arrives", async () => {
    const config = serverToolConfig["compress-pdf"];
    // Empty.
    await expect(
      validateUpload(new File([], "empty.pdf", { type: "application/pdf" }), config),
    ).rejects.toThrow(/empty/i);
    // Oversize — declared through the File's own size, not a header.
    const oversize = new File([PDF_BYTES], "big.pdf", { type: "application/pdf" });
    Object.defineProperty(oversize, "size", { value: config.maxSizeBytes + 1 });
    await expect(validateUpload(oversize, config)).rejects.toThrow(/limit/i);
    // An extension the tool never accepts.
    await expect(
      validateUpload(new File([PDF_BYTES], "invoice.exe", { type: "application/pdf" }), config),
    ).rejects.toThrow(/extension/i);
    // An explicit, clearly-wrong MIME.
    await expect(
      validateUpload(new File([PDF_BYTES], "invoice.pdf", { type: "text/html" }), config),
    ).rejects.toThrow(/type/i);
    // But the generic MIME real browsers send is accepted, and named honestly.
    await expect(
      validateUpload(
        new File([PDF_BYTES], "invoice.pdf", { type: "application/octet-stream" }),
        config,
      ),
    ).resolves.toMatchObject({ mimeType: "application/pdf" });
    // And nothing at all is not a file.
    await expect(validateUpload(null, config)).rejects.toThrow(UploadValidationError);
  });
});

/* ===================== Load, sessions, and what leaks ==================== */

describe("R21..R23 saturation, sessions, and error text", () => {
  it("R21 the concurrency ceiling holds, and a release admits the waiter", async () => {
    process.env.TOOLS_MAX_CONCURRENCY = "2";
    const { acquireSlot, TooBusyError } = await import("@/lib/server/concurrency");
    const first = await acquireSlot();
    const second = await acquireSlot();
    let admitted = false;
    const third = acquireSlot().then((release) => {
      admitted = true;
      return release;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Two slots, two holders: the third caller waits rather than starting a third
    // Ghostscript process on a box that has room for two.
    expect(admitted).toBe(false);
    first();
    const releaseThird = await third;
    expect(admitted).toBe(true);
    second();
    releaseThird();
    // The saturation error is for a stranger's screen: no queue depth, no env var,
    // no path, no process name.
    const message = new TooBusyError().message;
    expect(message).not.toMatch(/TOOLS_MAX_CONCURRENCY|ghostscript|soffice|\/|\d/i);
    expect(message.length).toBeLessThan(120);
  });

  it("R22 the session cookie is unreadable to script and cleared the same way it was set", () => {
    const set = sessionCookieOptions(60 * 60 * 24 * 30);
    const cleared = clearedSessionCookieOptions();
    expect(set.httpOnly).toBe(true);
    expect(set.sameSite).toBe("lax");
    expect(set.path).toBe("/");
    expect(set.maxAge).toBe(2592000);
    // A clear that differs in ANY attribute leaves the original cookie in place —
    // the browser matches on name, path and domain, so this must mirror exactly.
    for (const key of ["httpOnly", "sameSite", "secure", "path"] as const) {
      expect(cleared[key], key).toBe(set[key]);
    }
    expect(cleared.maxAge).toBe(0);
    // `secure` follows the environment rather than being hardcoded either way.
    expect(set.secure).toBe(process.env.NODE_ENV === "production");
  });

  it("R23 an unexpected failure reaches the client as a generic 500", async () => {
    const request = new Request("https://pdfdadi.test/api/workspaces/w1/documents");
    const response = mapWorkspaceError(
      request,
      new Error("connect ECONNREFUSED /var/run/postgres/.s.PGSQL.5432 as user pdfdadi_app"),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string; requestId?: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Workspace operation failed.");
    // Nothing of the cause survives: no host, no path, no username, no stack.
    for (const leak of ["ECONNREFUSED", "PGSQL", "/var/run", "pdfdadi_app", "at Object"]) {
      expect(JSON.stringify(body)).not.toContain(leak);
    }
    // A requestId still ties the screen to the log line that DOES have the cause.
    expect(body.error.requestId).toMatch(/[0-9a-f-]{8,}/);
  });
});

/* ============== What is measured, what is sold, what is offered ========== */

describe("R24..R27 measurement, pricing, capability truth", () => {
  it("R24 a failure event carries its category and nothing about the document", () => {
    const kept = sanitizeEventProperties("job_failed", {
      toolSlug: "compress-pdf",
      errorCategory: "timeout",
      fileName: "Q3 board pack.pdf",
      documentName: "Q3 board pack",
      userEmail: "someone@example.com",
      inputPath: "/var/tool-inputs/abc/Q3.pdf",
      nested: { name: "Q3 board pack.pdf" },
      empty: null,
      /*
       * The keys that prove it is the ALLOWLIST doing the work. Everything above is
       * also caught by the privacy denylist or the primitive check, so a version
       * with `allowed.has(key)` deleted still passed — mutation O1 found exactly
       * that. These two are undeclared for `job_failed`, contain no denylisted
       * substring, and are primitives, so only the closed taxonomy can drop them.
       */
      pageCount: 42,
      orgSeats: 8,
      stackFrame: "PdfToolWorkerHandler.run",
    });
    expect(Object.keys(kept).sort()).toEqual(["errorCategory", "toolSlug"]);
    expect(JSON.stringify(kept)).not.toContain("board pack");
    expect(JSON.stringify(kept)).not.toContain("PdfToolWorkerHandler");
    // An event nobody declared measures nothing at all, rather than everything.
    expect(sanitizeEventProperties("not_a_declared_event", { toolSlug: "x" })).toEqual({});
  });

  it("R25 a plan that cannot be bought shows no price and no checkout", () => {
    for (const plan of pricingPlans.filter((p) => !p.available)) {
      expect(plan.price, plan.id).not.toMatch(/\d/);
      expect(plan.href, plan.id).toMatch(/^\//);
      expect(plan.href, plan.id).not.toMatch(/checkout|billing|subscribe|upgrade/i);
      expect(plan.cta, plan.id).not.toMatch(/buy|subscribe|upgrade|checkout/i);
    }
    // Business is refused at the domain boundary too, not only in the copy: a
    // handcrafted POST naming it cannot reach a price lookup.
    expect(isPurchasablePlanId("business")).toBe(false);
    expect(isPurchasablePlanId("free")).toBe(false);
    expect(isPurchasablePlanId("PRO")).toBe(false);
    expect(isPurchasablePlanId({ id: "pro" })).toBe(false);
  });

  it("R26 the capability record cannot invent a tool, and answers only for real ones", () => {
    for (const slug of ["", "not-a-tool", "../../etc/passwd", "compress-pdf-x"]) {
      expect(capabilityForSlug(slug), slug).toBeNull();
    }
    const compress = capabilityForSlug("compress-pdf");
    expect(compress?.slug).toBe("compress-pdf");
    // The invariant the save route's 415 rests on: nothing claims a Workspace can
    // hold it unless it is a PDF, and nothing claims the editor can open it unless
    // a Workspace could hold it.
    for (const capability of TOOL_CAPABILITIES) {
      if (capability.workspaceSaveableOutput) expect(capability.outputKind, capability.slug).toBe("pdf");
      if (capability.editorOpenableOutput) {
        expect(capability.workspaceSaveableOutput, capability.slug).toBe(true);
      }
      // A tool nobody can run claims neither.
      if (capability.implementationState === "planned") {
        expect(capability.workspaceSaveableOutput, capability.slug).toBe(false);
        expect(capability.editorOpenableOutput, capability.slug).toBe(false);
      }
    }
  });

  it("R27 every way a save can fail says something different, and names nothing", () => {
    const cases: Array<[number, string | null]> = [
      [401, null],
      [403, null],
      [404, null],
      [409, "SAVE_INTENT_CONFLICT"],
      [413, "PAYLOAD_TOO_LARGE"],
      [415, "UNSUPPORTED_OUTPUT"],
      [500, null],
    ];
    const messages = cases.map(([status, code]) =>
      resultSaveFailureMessage(classifyResultSaveFailure(status, code)),
    );
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      // No id, no path, no status number, no internal vocabulary on a user's screen.
      expect(message).not.toMatch(/\bcm[a-z0-9]{20,}|\/api\/|workspaceId|\b(4|5)\d\d\b/);
      expect(message[0]).toBe(message[0].toUpperCase());
    }
    // The two the user can act on differently must not read identically.
    const unauthorized = resultSaveFailureMessage(classifyResultSaveFailure(401, null));
    const tooLarge = resultSaveFailureMessage(classifyResultSaveFailure(413, "PAYLOAD_TOO_LARGE"));
    expect(unauthorized).not.toBe(tooLarge);
  });
});

/* ====== The name a user sees, from their upload to their download ======== */

describe("R28..R30 the naming path, end to end", () => {
  it("R28 an output is named once, from the input that produced it", () => {
    // A space is kept — the policy's job is a name a person recognizes, and header
    // safety is `attachmentDisposition`'s job (R30 composes the two).
    expect(outputFileName({ sources: ["quarterly report.pdf"], suffix: "compressed", ext: "pdf" }))
      .toBe("quarterly report-compressed.pdf");
    // Running the same tool twice does not stack the suffix.
    expect(outputFileName({ sources: ["quarterly-report-compressed.pdf"], suffix: "compressed", ext: "pdf" }))
      .toBe("quarterly-report-compressed.pdf");
    // A conversion changes the extension rather than appending one.
    expect(outputFileName({ sources: ["deck.pptx"], ext: "pdf" })).toBe("deck.pdf");
    // And a nameless input still produces a name.
    expect(outputFileName({ sources: [null, "", undefined], ext: "pdf" })).toMatch(/^[\w-]+\.pdf$/);
  });

  it("R29 a hostile input name cannot become a path or a header", () => {
    for (const hostile of [
      "../../etc/passwd.pdf",
      `boom${String.fromCharCode(13, 10)}Set-Cookie: a=b.pdf`,
      `nul${String.fromCharCode(0)}.pdf`,
      "..",
      '"; filename="other.pdf',
    ]) {
      const produced = outputFileName({ sources: [hostile], suffix: "compressed", ext: "pdf" });
      expect(produced).not.toMatch(/[/\\]/);
      expect(produced).not.toMatch(/[\x00-\x1f"]/);
      expect(produced.endsWith(".pdf")).toBe(true);
    }
  });

  it("R30 the whole name path composes: upload name in, safe header out", async () => {
    const hostile = `../../etc/pas${String.fromCharCode(13, 10)}swd"; filename="x.pdf`;
    // 1. intake: the name is taken as-is but the extension must be allowed.
    const upload = await validateUpload(
      new File([PDF_BYTES], hostile, { type: "application/pdf" }),
      serverToolConfig["compress-pdf"],
    );
    // 2. staging: one path segment, from the sanitizer.
    const base = sanitizeBaseName(upload.originalName);
    expect(base).not.toMatch(/[/\\\x00-\x1f]/);
    // 3. naming policy: what the user is told the file is called.
    const produced = outputFileName({ sources: [upload.originalName], suffix: "compressed", ext: "pdf" });
    // 4. download: the header the browser parses.
    const header = attachmentDisposition(produced);
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header.split(";")).toHaveLength(3);
    expect(header).not.toMatch(/[\x00-\x1f]/);
    expect(header).not.toContain("Set-Cookie");
    expect(header).toContain("compressed");
  });
});
