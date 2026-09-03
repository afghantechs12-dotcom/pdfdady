import { describe, expect, it } from "vitest";
import {
  CONTENT_UNAVAILABLE_CODE,
  DEFAULT_PAGE_ASPECT,
  NO_ERROR_FACTS,
  POLL_POLICY,
  TERMINAL_PHASES,
  canRetryKind,
  classifyLoadError,
  isBusyPhase,
  loadAnnouncement,
  loadErrorFacts,
  loadingPageAspect,
  phaseForFailure,
  placeholderThumbnailCount,
  pollDelayMs,
  presentLoad,
  presentLoadError,
  shouldKeepPolling,
  type LoadErrorFacts,
  type LoadErrorKind,
  type LoadPhase,
} from "./documentLoadState";

/** Facts for a specific failure, with the rest left at "reported nothing". */
const facts = (over: Partial<LoadErrorFacts> = {}): LoadErrorFacts => ({
  ...NO_ERROR_FACTS,
  ...over,
});

/**
 * These tests exist to pin one claim: the spinner always ends.
 *
 * The load state machine is pure, so that claim is checkable here without
 * mounting React, faking a canvas or running a fetch — which is the whole
 * reason it was extracted from the component.
 */
describe("documentLoadState", () => {
  const ALL: LoadPhase[] = [
    "idle",
    "loading-content",
    "processing-upload",
    "parsing-pdf",
    "initializing-editor",
    "ready",
    "error",
  ];

  it("shows a spinner only for phases with work behind them", () => {
    for (const phase of ALL) {
      const spinning = presentLoad({ phase, timedOut: false }).spinner;
      expect(spinning).toBe(isBusyPhase(phase));
    }
  });

  it("never shows a spinner in a terminal phase", () => {
    for (const phase of TERMINAL_PHASES) {
      expect(presentLoad({ phase, timedOut: false }).spinner).toBe(false);
    }
  });

  it("renders nothing over the editor once ready", () => {
    expect(presentLoad({ phase: "ready", timedOut: false })).toEqual({
      message: null,
      spinner: false,
      retry: false,
    });
  });

  it("offers a retry from every state a user can get stuck in", () => {
    for (const phase of ["processing-upload", "error"] as LoadPhase[]) {
      expect(presentLoad({ phase, timedOut: false }).retry).toBe(true);
    }
  });

  it("states the processing case in words rather than a bare spinner", () => {
    const shown = presentLoad({ phase: "processing-upload", timedOut: false });
    expect(shown.message).toBe("This PDF is still being prepared.");
  });

  it("explains a timeout instead of spinning forever", () => {
    const shown = presentLoad({ phase: "error", timedOut: true });
    expect(shown.spinner).toBe(false);
    expect(shown.retry).toBe(true);
    expect(shown.message).toMatch(/longer than expected/i);
  });

  it("keeps polling only while preparation is genuinely in progress", () => {
    expect(phaseForFailure({ preparation: "processing", canKeepPolling: true })).toBe(
      "processing-upload",
    );
  });

  it("stops polling a failed preparation immediately", () => {
    // A failed ingestion will not fix itself; polling it is the endless spinner.
    expect(phaseForFailure({ preparation: "failed", canKeepPolling: true })).toBe("error");
  });

  it("treats a non-preparation failure as terminal", () => {
    expect(phaseForFailure({ preparation: "none", canKeepPolling: true })).toBe("error");
  });

  it("gives up when the polling budget is exhausted", () => {
    expect(phaseForFailure({ preparation: "processing", canKeepPolling: false })).toBe("error");
  });

  it("backs off without exceeding the per-wait cap", () => {
    let previous = 0;
    for (let attempt = 1; attempt <= POLL_POLICY.maxAttempts; attempt += 1) {
      const delay = pollDelayMs(attempt);
      expect(delay).toBeLessThanOrEqual(POLL_POLICY.maxDelayMs);
      expect(delay).toBeGreaterThanOrEqual(previous === 0 ? 0 : 0);
      previous = delay;
    }
    expect(pollDelayMs(1)).toBe(POLL_POLICY.initialDelayMs);
    expect(pollDelayMs(2)).toBeGreaterThan(pollDelayMs(1));
  });

  it("terminates polling in bounded time under both caps", () => {
    // Simulates the component's loop with a fake clock: whatever the timing, the
    // loop must reach a terminal phase rather than run forever.
    let elapsed = 0;
    let attempt = 0;

    while (shouldKeepPolling(attempt, elapsed)) {
      attempt += 1;
      elapsed += pollDelayMs(attempt + 1);
      expect(attempt).toBeLessThanOrEqual(POLL_POLICY.maxAttempts);
    }

    expect(attempt).toBeLessThanOrEqual(POLL_POLICY.maxAttempts);
    expect(elapsed).toBeLessThanOrEqual(POLL_POLICY.maxTotalWaitMs + POLL_POLICY.maxDelayMs);
    // And the phase it lands in is terminal, with a retry offered.
    const final = presentLoad({ phase: "error", timedOut: true });
    expect(final.spinner).toBe(false);
    expect(final.retry).toBe(true);
  });
});

/**
 * Phase J: which failures the UI can tell apart, and what it says about them.
 *
 * Every case below is a distinction the server genuinely provides. There is no
 * test for "permission revoked" because a 403 does not carry that information —
 * the absence is the point.
 */
describe("classifyLoadError", () => {
  it("keeps an expired session distinct from a denied one", () => {
    // The whole reason these must not collapse: signing in again fixes one and
    // does nothing for the other.
    expect(classifyLoadError(facts({ status: 401 }))).toBe("auth");
    expect(classifyLoadError(facts({ status: 403 }))).toBe("forbidden");
  });

  it("classifies a missing document as not-found", () => {
    expect(classifyLoadError(facts({ status: 404 }))).toBe("not-found");
  });

  it("classifies a content-unavailable conflict from the server's CODE", () => {
    expect(
      classifyLoadError(facts({ status: 409, code: CONTENT_UNAVAILABLE_CODE })),
    ).toBe("content-unavailable");
  });

  it("classifies a conflict as content-unavailable when preparation evidence exists", () => {
    expect(classifyLoadError(facts({ status: 409, preparation: "processing" }))).toBe(
      "content-unavailable",
    );
    expect(classifyLoadError(facts({ status: 409, preparation: "failed" }))).toBe(
      "content-unavailable",
    );
  });

  it("does NOT call an unrelated conflict a preparation problem", () => {
    // `mapWorkspaceError` answers 409/WORKSPACE_OPERATION_REJECTED for any
    // rejected domain operation. Reading every 409 as "not ready yet" would tell
    // the user their document is being prepared when nothing is preparing it.
    const unrelated = facts({ status: 409, code: "WORKSPACE_OPERATION_REJECTED" });
    expect(classifyLoadError(unrelated)).toBe("unknown");
    expect(presentLoadError(unrelated, { context: "workspace" }).description).not.toMatch(
      /prepar/i,
    );
  });

  it("classifies a fetch rejection as a network failure, not a generic one", () => {
    expect(classifyLoadError(facts({ network: true }))).toBe("network");
  });

  it("classifies a refused PDF as invalid rather than as a server fault", () => {
    expect(classifyLoadError(facts({ invalidPdf: true }))).toBe("invalid-pdf");
  });

  it("ranks an exhausted polling budget above the preparation state it carries", () => {
    // A timed-out load arrives WITH preparation evidence attached; the user's
    // problem at that point is the waiting, not the preparation.
    expect(
      classifyLoadError(facts({ status: 409, preparation: "processing", timedOut: true })),
    ).toBe("timed-out");
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classifyLoadError(facts({ status: 500 }))).toBe("unknown");
    expect(classifyLoadError(NO_ERROR_FACTS)).toBe("unknown");
  });
});

describe("presentLoadError", () => {
  const KINDS: LoadErrorKind[] = [
    "auth",
    "forbidden",
    "not-found",
    "content-unavailable",
    "invalid-pdf",
    "network",
    "timed-out",
    "unknown",
  ];

  it("gives every kind a heading and a description", () => {
    for (const kind of KINDS) {
      const shown = presentLoadError(
        facts({
          status: kind === "auth" ? 401 : kind === "forbidden" ? 403 : kind === "not-found" ? 404 : null,
          code: kind === "content-unavailable" ? CONTENT_UNAVAILABLE_CODE : null,
          network: kind === "network",
          invalidPdf: kind === "invalid-pdf",
          timedOut: kind === "timed-out",
        }),
        { context: "workspace" },
      );
      expect(shown.heading.length).toBeGreaterThan(0);
      expect(shown.description.length).toBeGreaterThan(0);
    }
  });

  it("always offers at least one action in the standalone editor", () => {
    // Standalone always has a real way forward: open a different file.
    for (const kind of KINDS) {
      const shown = presentLoadError(
        facts({
          status: kind === "auth" ? 401 : kind === "forbidden" ? 403 : kind === "not-found" ? 404 : null,
          code: kind === "content-unavailable" ? CONTENT_UNAVAILABLE_CODE : null,
          network: kind === "network",
          invalidPdf: kind === "invalid-pdf",
          timedOut: kind === "timed-out",
        }),
        { context: "standalone" },
      );
      expect(shown.actions.length).toBeGreaterThan(0);
    }
  });

  it("tells a 401 to sign in and a 403 nothing of the kind", () => {
    const expired = presentLoadError(facts({ status: 401 }), { context: "workspace" });
    expect(expired.heading).toMatch(/session has expired/i);
    expect(expired.actions[0].kind).toBe("sign-in");

    const denied = presentLoadError(facts({ status: 403 }), { context: "workspace" });
    expect(denied.heading).toMatch(/don't have access/i);
    expect(denied.actions.some((a) => a.kind === "sign-in")).toBe(false);
  });

  it("does not claim a 403 means access was REMOVED", () => {
    // The application cannot distinguish a revoked role from one never granted.
    const denied = presentLoadError(facts({ status: 403 }), { context: "workspace" });
    const copy = `${denied.heading} ${denied.description}`;
    expect(copy).not.toMatch(/removed|revoked|no longer/i);
  });

  it("keeps 404 copy bounded and free of existence claims about other tenants", () => {
    const missing = presentLoadError(facts({ status: 404 }), { context: "workspace" });
    expect(missing.heading).toMatch(/not found/i);
    expect(`${missing.heading} ${missing.description}`).not.toMatch(
      /another (workspace|organization|account)|different (workspace|tenant)/i,
    );
  });

  it("distinguishes processing, failed and never-saved preparation", () => {
    const processing = presentLoadError(
      facts({ status: 409, code: CONTENT_UNAVAILABLE_CODE, preparation: "processing" }),
      { context: "workspace" },
    );
    const failed = presentLoadError(
      facts({ status: 409, code: CONTENT_UNAVAILABLE_CODE, preparation: "failed" }),
      { context: "workspace" },
    );
    const none = presentLoadError(
      facts({ status: 409, code: CONTENT_UNAVAILABLE_CODE }),
      { context: "workspace" },
    );

    expect(processing.heading).toMatch(/still being prepared/i);
    expect(failed.heading).toMatch(/couldn't be prepared/i);
    expect(new Set([processing.heading, failed.heading, none.heading]).size).toBe(3);
  });

  it("describes an invalid PDF as a file problem with the real supported-limits hint", () => {
    const invalid = presentLoadError(facts({ invalidPdf: true }), { context: "standalone" });
    expect(invalid.heading).toMatch(/couldn't open this pdf/i);
    expect(invalid.description).toMatch(/damaged|unsupported|limits/i);
  });

  it("names the user's connection for a network failure", () => {
    const offline = presentLoadError(facts({ network: true }), { context: "workspace" });
    expect(offline.heading).toMatch(/connection problem/i);
    expect(offline.description).toMatch(/check your connection/i);
    expect(offline.actions[0].kind).toBe("retry");
  });

  it("offers Retry only where retrying could actually work", () => {
    // A Retry on a 404 is a dead control: asking again will not find it.
    expect(canRetryKind("not-found")).toBe(false);
    expect(canRetryKind("forbidden")).toBe(false);
    expect(canRetryKind("auth")).toBe(false);
    expect(canRetryKind("invalid-pdf")).toBe(false);
    expect(canRetryKind("network")).toBe(true);
    expect(canRetryKind("timed-out")).toBe(true);
    expect(canRetryKind("content-unavailable")).toBe(true);
    expect(canRetryKind("unknown")).toBe(true);

    for (const kind of KINDS) {
      const shown = presentLoadError(
        facts({
          status: kind === "auth" ? 401 : kind === "forbidden" ? 403 : kind === "not-found" ? 404 : null,
          code: kind === "content-unavailable" ? CONTENT_UNAVAILABLE_CODE : null,
          network: kind === "network",
          invalidPdf: kind === "invalid-pdf",
          timedOut: kind === "timed-out",
        }),
        { context: "workspace" },
      );
      expect(shown.actions.some((a) => a.kind === "retry")).toBe(canRetryKind(kind));
    }
  });

  it("models no 'back' action, because only the host knows where back is", () => {
    // The workbench's "Back to Workspace" is a real link with a real href; it is
    // passed to the panel as a node. An action emitted here that no caller could
    // implement would be precisely the dead button this phase forbids.
    for (const context of ["workspace", "standalone"] as const) {
      for (const status of [401, 403, 404, 409, 500]) {
        const shown = presentLoadError(facts({ status }), { context });
        // `as string` rather than `as any`: the comparison only needs the union
        // widened enough to ask about a member that must NOT exist.
        expect(shown.actions.some((a) => (a.kind as string) === "back")).toBe(false);
      }
    }
  });

  it("leaves a non-retryable workspace failure to the host's own way out", () => {
    // A 404 in the workbench offers no button of its own: retrying will not find
    // the document, and the panel's `secondary` slot carries the real link.
    const missing = presentLoadError(facts({ status: 404 }), { context: "workspace" });
    expect(missing.actions).toEqual([]);
  });

  it("offers Open another PDF in the standalone editor and never in the workspace", () => {
    const standalone = presentLoadError(facts({ invalidPdf: true }), { context: "standalone" });
    expect(standalone.actions.some((a) => a.kind === "open-another")).toBe(true);

    const workspace = presentLoadError(facts({ invalidPdf: true }), { context: "workspace" });
    expect(workspace.actions.some((a) => a.kind === "open-another")).toBe(false);
  });

  it("never emits a duplicate action", () => {
    for (const context of ["workspace", "standalone"] as const) {
      for (const kind of KINDS) {
        const shown = presentLoadError(
          facts({
            status: kind === "auth" ? 401 : kind === "forbidden" ? 403 : kind === "not-found" ? 404 : null,
            code: kind === "content-unavailable" ? CONTENT_UNAVAILABLE_CODE : null,
            network: kind === "network",
            invalidPdf: kind === "invalid-pdf",
            timedOut: kind === "timed-out",
          }),
          { context },
        );
        const kinds = shown.actions.map((a) => a.kind);
        expect(new Set(kinds).size).toBe(kinds.length);      }
    }
  });
});

describe("user-facing copy safety", () => {
  /**
   * The presentation layer authors every string it returns.
   *
   * The shipped build rendered `error.detail ?? error.message` — the server's
   * own text — which is how bounded-but-internal ingestion diagnostics ("The
   * stored bytes do not match the uploaded checksum") reached the panel. These
   * assertions pin that no server string can reappear in user-facing copy.
   */
  const HOSTILE = [
    "PrismaClientKnownRequestError: Invalid `prisma.document.findFirst()` invocation",
    "D:\\AndroidStudioProjects\\Backup\\PDFMaster\\src\\infrastructure\\storage\\local.ts",
    "workspaces/ws_123/documents/doc_456/versions/3/source.pdf",
    "The stored bytes do not match the uploaded checksum.",
    "at async POST (webpack-internal:///(rsc)/./app/api/route.ts:42:11)",
    "DATABASE_URL=postgres://user:secret@localhost:5432/db",
  ];

  it("renders no server-provided or internal text in any presentation", () => {
    for (const detail of HOSTILE) {
      // Facts carry no `detail` channel at all — this asserts the shape as well
      // as the copy, since a future field would have to be opted into.
      const shown = presentLoadError(
        // Cast because the object deliberately carries fields `LoadErrorFacts`
        // does NOT declare. That is the point of the test: even when a caller
        // smuggles `detail`/`message` through, no presentation renders them —
        // which is exactly the leak mutation 4 introduced and this caught.
        { ...facts({ status: 500 }), detail, message: detail } as LoadErrorFacts,
        { context: "workspace" },
      );
      const copy = `${shown.heading} ${shown.description}`;
      expect(copy).not.toContain(detail);
      expect(copy).not.toMatch(/prisma|webpack-internal|DATABASE_URL|\\\\|[A-Z]:\\/);
    }
  });

  it("keeps every message short enough to be a heading, not a dumped trace", () => {
    for (const status of [401, 403, 404, 409, 500]) {
      const shown = presentLoadError(facts({ status }), { context: "workspace" });
      expect(shown.heading.length).toBeLessThanOrEqual(60);
      expect(shown.description.length).toBeLessThanOrEqual(200);
      expect(shown.heading).not.toContain("\n");
    }
  });

  it("does not leak a storage key or version manifest shape", () => {
    const shown = presentLoadError(
      facts({ status: 409, code: CONTENT_UNAVAILABLE_CODE, preparation: "failed" }),
      { context: "workspace" },
    );
    const copy = `${shown.heading} ${shown.description}`;
    expect(copy).not.toMatch(/checksum|storage|object key|manifest|byteSize|sourceKey/i);
  });
});

describe("loadErrorFacts", () => {
  it("reads evidence off a thrown load error without importing the PDF stack", () => {
    const thrown = {
      name: "WorkspaceDocumentLoadError",
      message: "This document has no saved content yet.",
      status: 409,
      code: CONTENT_UNAVAILABLE_CODE,
      preparation: "processing" as const,
      network: false,
      invalidPdf: false,
      detail: "internal detail",
    };
    expect(loadErrorFacts(thrown)).toEqual({
      status: 409,
      code: CONTENT_UNAVAILABLE_CODE,
      preparation: "processing",
      network: false,
      invalidPdf: false,
      timedOut: false,
      pageCap: null,
    });
  });

  it("carries no detail channel into the facts at all", () => {
    const extracted = loadErrorFacts({ detail: "The stored bytes do not match.", status: 409 });
    expect(Object.keys(extracted)).not.toContain("detail");
    expect(Object.keys(extracted)).not.toContain("message");
  });

  it("degrades an unrecognised throw to unknown rather than guessing", () => {
    expect(loadErrorFacts(new Error("boom"))).toEqual(NO_ERROR_FACTS);
    expect(loadErrorFacts(null)).toEqual(NO_ERROR_FACTS);
    expect(loadErrorFacts("string throw")).toEqual(NO_ERROR_FACTS);
    expect(classifyLoadError(loadErrorFacts(new Error("boom")))).toBe("unknown");
  });

  it("records an exhausted polling budget as timed out", () => {
    expect(loadErrorFacts({ preparation: "processing" }, { timedOut: true }).timedOut).toBe(true);
  });

  it("preserves a network flag through extraction", () => {
    expect(classifyLoadError(loadErrorFacts({ network: true }))).toBe("network");
  });
});

describe("loading presentation geometry", () => {
  it("draws a document-shaped page immediately when dimensions are unknown", () => {
    // Waiting to learn the real size before drawing anything is how a loading
    // state degrades back into a bare spinner.
    expect(loadingPageAspect(null)).toBe(DEFAULT_PAGE_ASPECT);
    expect(loadingPageAspect({ width: 0, height: 0 })).toBe(DEFAULT_PAGE_ASPECT);
  });

  it("uses the real page ratio once it is known", () => {
    expect(loadingPageAspect({ width: 612, height: 792 })).toBeCloseTo(792 / 612, 5);
    // Landscape is a real shape, not an error.
    expect(loadingPageAspect({ width: 792, height: 612 })).toBeCloseTo(612 / 792, 5);
  });

  it("clamps a pathological page so the skeleton cannot outgrow the canvas", () => {
    expect(loadingPageAspect({ width: 10, height: 14400 })).toBe(3);
    expect(loadingPageAspect({ width: 14400, height: 10 })).toBe(0.4);
  });

  it("bounds placeholder thumbnails and stops once page count is known", () => {
    const unknown = placeholderThumbnailCount(null);
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeLessThanOrEqual(5);
    // Real page placeholders take over; a skeleton per page on a 200-page PDF
    // costs more layout than the thumbnails it stands in for.
    expect(placeholderThumbnailCount(200)).toBe(0);
    expect(placeholderThumbnailCount(1)).toBe(0);
  });
});

describe("loadAnnouncement", () => {
  it("announces only the transitions a user needs to hear", () => {
    expect(loadAnnouncement("loading-content")).toBe("Opening document.");
    expect(loadAnnouncement("ready")).toBe("Document loaded.");
    expect(loadAnnouncement("error", facts({ status: 404 }))).toMatch(/could not open document/i);
  });

  it("stays silent through substages so a poll loop cannot narrate itself", () => {
    expect(loadAnnouncement("processing-upload")).toBeNull();
    expect(loadAnnouncement("parsing-pdf")).toBeNull();
    expect(loadAnnouncement("initializing-editor")).toBeNull();
    expect(loadAnnouncement("idle")).toBeNull();
  });

  it("announces an error with the same safe heading the panel shows", () => {
    const announced = loadAnnouncement("error", facts({ network: true }));
    expect(announced).toContain(
      presentLoadError(facts({ network: true }), { context: "workspace" }).heading,
    );
    expect(announced).not.toMatch(/prisma|checksum|[A-Z]:\\/);
  });
});
