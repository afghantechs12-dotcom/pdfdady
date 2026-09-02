import { describe, expect, it } from "vitest";
import {
  REMOTE_ENVELOPE_ALLOWANCE,
  REMOTE_DRAFT_FORMAT,
} from "@/src/application/editor/persistence/remotePayload";
import type { RemoteSavePayload } from "@/src/application/editor/persistence/ports";
import { AUTOSAVE_DRAFT_LIMITS } from "@/src/domain/entities/AutosaveDraft";
import {
  REMOTE_SNAPSHOT_FORMAT,
  REMOTE_SNAPSHOT_VERSION,
  WorkspaceAutosaveTransport,
  type RemoteSnapshotEnvelope,
} from "./WorkspaceAutosaveTransport";

/**
 * The transport's one job is to be honest about what happened.
 *
 * Three shapes make that hard, and all three are tested here. A 200 whose body
 * says `status: "conflict"` — the draft was stored, so nothing is lost, but the
 * document moved on and the save must not read as synced. A 200 whose body is not
 * the documented shape at all, where the bytes may well have landed but this
 * client cannot prove it. And the version mapping: the editor's revision and the
 * server's document revision are different numbers, and sending one where the
 * other belongs either conflicts on every save or silently overwrites concurrent
 * work.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch double that answers the document GET and records the autosave POST. */
function fetcher(options: {
  serverVersion?: number | null;
  autosave?: (call: Call) => Response;
  documentStatus?: number;
} = {}) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (url.includes("/autosave")) {
      return (
        options.autosave?.(call) ?? json(200, { draft: { status: "stored", checksum: "sum-1" } })
      );
    }
    if (options.documentStatus && options.documentStatus !== 200) {
      return json(options.documentStatus, { error: { message: "nope" } });
    }
    return json(200, {
      document: { revision: options.serverVersion ?? 9, updatedAt: 1_000 },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function payload(overrides: Partial<RemoteSavePayload> = {}): RemoteSavePayload {
  return {
    documentId: "doc-1",
    workspaceId: "w1",
    organizationId: "org-1",
    deviceId: "device-1",
    revision: 12,
    expectedServerVersion: 9,
    etag: null,
    snapshot: { format: REMOTE_DRAFT_FORMAT, version: 1, record: {}, assets: [], omitted: [] },
    clientTimestamp: 1_700,
    ...overrides,
  };
}

function envelopeOf(call: Call): RemoteSnapshotEnvelope {
  const body = call.body as { payload?: unknown };
  return JSON.parse(String(body.payload)) as RemoteSnapshotEnvelope;
}

describe("the version mapping", () => {
  it("sends the SERVER version in both concurrency fields, never the editor revision", () => {
    const { impl, calls } = fetcher();
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    return subject.save(payload({ revision: 12, expectedServerVersion: 9 })).then(() => {
      const post = calls.find((call) => call.url.includes("/autosave"))!;
      const body = post.body as { baseVersion: number; expectedRevision: number };
      expect(body.baseVersion).toBe(9);
      expect(body.expectedRevision).toBe(9);
      // The editor revision travels as data, inside the opaque payload.
      expect(envelopeOf(post).revision).toBe(12);
    });
  });

  it("reads the current version rather than guessing zero when it does not know one", async () => {
    const { impl, calls } = fetcher({ serverVersion: 14 });
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload({ expectedServerVersion: null }));
    expect(calls[0]!.method).toBe("GET");
    const post = calls.find((call) => call.url.includes("/autosave"))!;
    expect((post.body as { expectedRevision: number }).expectedRevision).toBe(14);
    expect(outcome).toEqual({ kind: "saved", serverVersion: 14, etag: "sum-1" });
  });

  it("does not send anything when the version read failed", async () => {
    const { impl, calls } = fetcher({ documentStatus: 500 });
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload({ expectedServerVersion: null }));
    expect(outcome.kind).toBe("failed");
    expect(calls.some((call) => call.url.includes("/autosave"))).toBe(false);
  });

  it("echoes the base version back rather than incrementing it", async () => {
    /*
     * An autosave draft does not create a document revision. Reporting `expected +
     * 1` would make the very next save present a version the server never issued,
     * which is an instant, self-inflicted conflict.
     */
    const { impl } = fetcher();
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload({ expectedServerVersion: 9 }));
    expect(outcome).toEqual({ kind: "saved", serverVersion: 9, etag: "sum-1" });
  });
});

describe("a response that is not the success it appears to be", () => {
  it("treats a 200 whose draft says conflict as a conflict", async () => {
    const { impl } = fetcher({
      serverVersion: 11,
      autosave: () =>
        json(200, { draft: { status: "conflict", failureReason: "Someone else saved first." } }),
    });
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload({ expectedServerVersion: 9 }));
    expect(outcome).toEqual({
      kind: "conflict",
      actualServerVersion: 11,
      expectedServerVersion: 9,
      detail: "Someone else saved first.",
    });
  });

  it("treats a 409 as a conflict and enriches it with the version it can read", async () => {
    const { impl } = fetcher({
      serverVersion: 13,
      autosave: () => json(409, { error: { message: "The draft changed concurrently." } }),
    });
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload());
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.actualServerVersion).toBe(13);
  });

  it("keeps the conflict when the enriching read fails", async () => {
    let first = true;
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/autosave")) return json(409, {});
      if (first) {
        first = false;
        return json(200, { document: { revision: 9 } });
      }
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload({ expectedServerVersion: null }));
    // A conflict is the fact; the version numbers are context it degrades without.
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.actualServerVersion).toBeNull();
  });

  it("refuses to call an unreadable 200 a save", async () => {
    const { impl } = fetcher({
      autosave: () => new Response("<html>proxy</html>", { status: 200 }),
    });
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.category).toBe("unknown");
    // Unknown is retryable: the bytes may have landed, and asking again is the only
    // way to find out.
    expect(outcome.failure.retryable).toBe(true);
  });

  it("does not read a missing checksum as an etag", async () => {
    const { impl } = fetcher({ autosave: () => json(200, { draft: { status: "stored" } }) });
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload());
    expect(outcome).toEqual({ kind: "saved", serverVersion: 9, etag: null });
  });
});

describe("classifying a refusal", () => {
  const cases: { status: number; category: string; retryable: boolean }[] = [
    { status: 401, category: "unauthorized", retryable: false },
    { status: 403, category: "unauthorized", retryable: false },
    { status: 404, category: "rejected", retryable: true },
    { status: 413, category: "payload_too_large", retryable: false },
    { status: 422, category: "rejected", retryable: true },
    { status: 429, category: "timeout", retryable: true },
    { status: 500, category: "network", retryable: true },
    { status: 503, category: "network", retryable: true },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.status} to ${testCase.category}`, async () => {
      const { impl } = fetcher({
        autosave: () => json(testCase.status, { error: { message: "refused" } }),
      });
      const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
      const outcome = await subject.save(payload());
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.failure.category).toBe(testCase.category);
      expect(outcome.failure.retryable).toBe(testCase.retryable);
    });
  }

  it("calls a thrown fetch a network failure, because nothing reached the server", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.category).toBe("network");
  });

  it("calls its own abort a timeout rather than a network failure", async () => {
    const impl = (async () => {
      throw new DOMException("Timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.category).toBe("timeout");
  });
});

describe("the size pre-flight", () => {
  it("refuses an oversized payload before spending the user's upload on it", async () => {
    const { impl, calls } = fetcher();
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl, maxPayloadBytes: 512 });
    const outcome = await subject.save(payload({ snapshot: { big: "x".repeat(4_000) } }));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.category).toBe("payload_too_large");
    expect(outcome.failure.retryable).toBe(false);
    expect(calls.some((call) => call.url.includes("/autosave"))).toBe(false);
  });

  it("defaults to the domain limit, so client and server agree by construction", async () => {
    const { impl } = fetcher();
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const justUnder = "x".repeat(AUTOSAVE_DRAFT_LIMITS.maxPayloadBytes - 4_096);
    const outcome = await subject.save(payload({ snapshot: { big: justUnder } }));
    expect(outcome.kind).toBe("saved");
  });

  it("the envelope allowance covers the real overhead", () => {
    /*
     * Holds `REMOTE_ENVELOPE_ALLOWANCE` to the actual envelope rather than to a
     * comment. If a field is ever added here that pushes the wrapper past the
     * allowance, the snapshot planner's budget stops being conservative and a
     * payload it approved could come back as a 413 — with the user having been
     * told the backup succeeded.
     */
    const envelope: RemoteSnapshotEnvelope = {
      format: REMOTE_SNAPSHOT_FORMAT,
      version: REMOTE_SNAPSHOT_VERSION,
      revision: Number.MAX_SAFE_INTEGER,
      expectedServerVersion: Number.MAX_SAFE_INTEGER,
      etag: "x".repeat(64),
      clientTimestamp: Number.MAX_SAFE_INTEGER,
      snapshot: null,
    };
    const overhead = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    expect(overhead).toBeLessThan(REMOTE_ENVELOPE_ALLOWANCE);
  });

  it("reports a scene it cannot serialize as an integrity failure, not a network one", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { impl } = fetcher();
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const outcome = await subject.save(payload({ snapshot: cyclic }));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.category).toBe("integrity_failed");
  });
});

describe("reading the current version", () => {
  it("never accepts a cached answer, because a stale version turns detection into overwriting", async () => {
    const seen: RequestInit[] = [];
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return json(200, { document: { revision: 9 } });
    }) as unknown as typeof fetch;
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    await subject.readVersion({
      documentId: "doc-1",
      workspaceId: "w1",
      organizationId: "org-1",
      deviceId: "device-1",
    });
    expect(seen[0]!.cache).toBe("no-store");
  });

  it("reports a deleted document as having no version rather than as an error", async () => {
    const impl = (async () => json(404, {})) as unknown as typeof fetch;
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const read = await subject.readVersion({
      documentId: "doc-1",
      workspaceId: "w1",
      organizationId: "org-1",
      deviceId: "device-1",
    });
    expect(read).toBeNull();
  });

  it("fabricates no validator, because a made-up etag would prove equivalence falsely", async () => {
    const impl = (async () =>
      json(200, { document: { revision: 9, updatedAt: 5 } })) as unknown as typeof fetch;
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const read = await subject.readVersion({
      documentId: "doc-1",
      workspaceId: "w1",
      organizationId: "org-1",
      deviceId: "device-1",
    });
    expect(read).toEqual({ serverVersion: 9, etag: null });
  });

  it("treats a non-numeric revision as no version at all", async () => {
    const impl = (async () =>
      json(200, { document: { revision: "nine" } })) as unknown as typeof fetch;
    const subject = new WorkspaceAutosaveTransport({ fetchImpl: impl });
    const read = await subject.readVersion({
      documentId: "doc-1",
      workspaceId: "w1",
      organizationId: "org-1",
      deviceId: "device-1",
    });
    expect(read).toBeNull();
  });
});
