import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { commitToWorkspace, type WorkspaceCommitAck } from "./standaloneShellLogic";
import {
  DocumentPersistenceCoordinator,
  type CoordinatorPorts,
} from "@/src/application/editor/persistence/DocumentPersistenceCoordinator";
import { createDiagnostics } from "@/src/application/editor/persistence/diagnostics";
import { DraftRepository } from "@/src/application/editor/persistence/draftRepository";
import { guestDocumentKey } from "@/src/application/editor/persistence/draftEnvelope";
import { MemoryKeyValueStore } from "@/src/application/editor/persistence/testing/memoryKeyValueStore";
import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";

/**
 * Phase 2 closeout: the explicit "Save to Workspace" commit, driven end to end
 * through the REAL coordinator and the REAL reducer.
 *
 * The projection was already correct and already tested. What shipped broken was
 * the wiring: `noteVersionCommitted` had no production caller, so
 * `committedServerVersion` was null forever and the version copy was unreachable.
 * A pure test of the reducer could not have caught that, which is why these tests
 * drive `commitToWorkspace` — the production orchestrator the shell now calls —
 * against a real coordinator instead of asserting on hand-built events.
 *
 * `NOTHING_DURABLE` is spelled out rather than imported: a test that tracked the
 * constant would keep passing if it stopped meaning "nothing".
 */
const NOTHING_DURABLE = -1;

/** A hand-driven clock. No real time passes in this file. */
class Clock {
  now = 1_700_000_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = target;
  }
}

function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

const SCENE: SerializedEditorState = {
  format: "pdfdadi-editor",
  version: 6,
  document: { pages: [{ id: "page-1", objects: [] }] },
  activePageId: "page-1",
  selection: { objectIds: [] },
};

/** The pages a scene sits on. Not a real PDF — nothing here parses one. */
const SOURCE_BYTES = new Uint8Array([37, 80, 68, 70]);

/**
 * A scene STAMPED with the revision it was taken at.
 *
 * The stamp is what lets a test tell which document reached the commit. Without
 * it every save would publish an identical scene and "the commit carried the scene
 * that was exported" would be unfalsifiable — a mutation that serialized the scene
 * after the export, or published a stale one, would pass.
 */
function sceneAtRevision(revision: number): SerializedEditorState {
  return { ...SCENE, document: { pages: [{ id: "page-1", objects: [] }], revision } };
}

/**
 * The standalone editor as the shell sees it: a guest-origin document (no autosave
 * channel, exactly like `/editor`) plus the two things the surface handle exposes —
 * bytes paired with the revision they were rendered from, and the commit
 * acknowledgement.
 */
class Surface {
  readonly clock = new Clock();
  readonly coordinator: DocumentPersistenceCoordinator;
  /** Every revision `exportBytes` handed out, in order. */
  readonly exported: number[] = [];
  private nextId = 1;

  constructor() {
    const store = new MemoryKeyValueStore();
    const ports: CoordinatorPorts = {
      store,
      repository: new DraftRepository(store),
      // Null on purpose: the standalone surface has no autosave transport, which is
      // the case the shipped gate on `remoteEnabled` made unreachable.
      transport: null,
      diagnostics: createDiagnostics({ now: () => this.clock.now }),
      capture: () => ({
        scene: SCENE,
        sourceBytes: new Uint8Array([37, 80, 68, 70]),
        sourceReference: null,
        documentName: "Contract.pdf",
        pageCount: 1,
        objectCount: 0,
      }),
      now: () => this.clock.now,
      newId: () => `id-${this.nextId++}`,
      setTimer: this.clock.setTimer,
      clearTimer: this.clock.clearTimer,
      onStateChange: () => {},
      deviceId: "device-A",
      tabId: "tab-1",
      localConfig: { debounceMs: 10, maxDelayMs: 40, retryDelaysMs: [] },
      remoteConfig: { debounceMs: 10, maxDelayMs: 40, retryDelaysMs: [] },
    };
    this.coordinator = new DocumentPersistenceCoordinator(ports);
  }

  async open(): Promise<void> {
    await this.coordinator.openDocument({
      documentKey: guestDocumentKey("guest-doc-1"),
      documentId: null,
      workspaceId: null,
      organizationId: null,
      origin: "guest",
      historyRevision: 0,
      online: true,
      serverVersion: null,
      etag: null,
    });
  }

  /**
   * One committed edit, then the local write runs out and settles. Returns the
   * PERSISTENCE revision it produced.
   *
   * The history revision jumps by three each time on purpose: `CommandHistory`
   * advances per frame and per load while the `RevisionBridge` counts committed
   * mutations, so the two numbers are never interchangeable. Keeping them visibly
   * different means a wiring that handed the history revision to the machine would
   * fail these tests instead of coincidentally agreeing with them.
   */
  async edit(): Promise<number> {
    this.historyRevision += 3;
    this.coordinator.noteMutation(this.historyRevision);
    this.clock.advance(20);
    await settle();
    return this.coordinator.view.state.currentRevision;
  }

  /** Edits until the persistence revision reaches `target`. */
  async editTo(target: number): Promise<void> {
    while (this.coordinator.view.state.currentRevision < target) await this.edit();
  }

  historyRevision = 0;

  /**
   * The handle's `exportBytes`: the revision is read WITH the bytes, at issuance.
   * `EditorWorkspace` reads its render-time revision for the same reason, and the
   * source-text test at the bottom of this file pins that it still does.
   */
  exportBytes = async (): Promise<{
    bytes: Uint8Array;
    revision: number;
    scene: SerializedEditorState;
    sourceBytes: Uint8Array | null;
  }> => {
    const revision = this.coordinator.view.state.currentRevision;
    this.exported.push(revision);
    /*
     * The scene is read in the SAME TICK as the revision, before the await — the
     * property the real handle has to hold, since a scene serialized after the
     * export would describe a document the user had already edited past.
     */
    const scene = sceneAtRevision(revision);
    await settle();
    return { bytes: new Uint8Array([1, 2, 3]), revision, scene, sourceBytes: SOURCE_BYTES };
  };

  noteVersionCommitted = (input: {
    revision: number;
    serverVersion: number | null;
    documentRevision?: number | null;
    etag: string | null;
  }): void => this.coordinator.noteVersionCommitted(input);

  get state() {
    return this.coordinator.view.state;
  }

  get status() {
    return this.coordinator.view.status;
  }
}

/** The shell's ports, with the network replaced by whatever the test needs. */
function ports(
  surface: Surface,
  options: {
    documentId?: string | null;
    create?: () => Promise<WorkspaceCommitAck>;
    commit?: (
      documentId: string,
      scene: SerializedEditorState,
      sourceBytes: Uint8Array | null,
    ) => Promise<WorkspaceCommitAck>;
  } = {},
) {
  let held = options.documentId ?? null;
  return {
    ports: {
      exportBytes: surface.exportBytes,
      existingDocumentId: () => held,
      create:
        options.create ??
        (async () => ({ documentId: "doc-1", serverVersion: null, documentRevision: null })),
      commit:
        options.commit === undefined
          ? async (documentId: string) => ({
              documentId,
              serverVersion: 7,
              /*
               * NOT 7, and not 8 either. The document revision advances on renames,
               * favourites and moves as well as on versions, so by version 7 it is
               * some larger unrelated number — and it is the one the next
               * compare-and-swap must use. Every fake ack in this file keeps the two
               * apart so a machine that stored the version number as its CAS token
               * cannot pass.
               */
              documentRevision: 11,
            })
          : (
              documentId: string,
              _bytes: Uint8Array,
              scene: SerializedEditorState,
              sourceBytes: Uint8Array | null,
            ) => options.commit!(documentId, scene, sourceBytes),
      onDocumentCreated: (documentId: string | null) => {
        held = documentId;
      },
      noteVersionCommitted: surface.noteVersionCommitted,
    },
    documentId: () => held,
  };
}

describe("explicit Workspace commit reaches the canonical persistence machine", () => {
  it("1. a successful commit records the revision AND the server's version number", async () => {
    const surface = new Surface();
    await surface.open();
    await surface.editTo(4);

    // The two revision domains, visibly apart: 12 mutations' worth of history
    // churn is persistence revision 4, and 4 is the only one of the two the
    // machine may ever be told about.
    expect(surface.historyRevision).toBe(12);
    expect(surface.state.currentRevision).toBe(4);
    // The gap this closes, asserted BEFORE the commit so the test cannot pass
    // vacuously on a state that was already committed.
    expect(surface.state.lastCommittedRevision).toBe(NOTHING_DURABLE);
    expect(surface.state.committedServerVersion).toBeNull();

    const { ports: p } = ports(surface, { documentId: "doc-1" });
    await commitToWorkspace(p);
    await settle();

    expect(surface.state.lastCommittedRevision).toBe(4);
    // From the RESPONSE, not from any client-side counter.
    expect(surface.state.committedServerVersion).toBe(7);
    // And the canonical projection may now say so — the sentence that was
    // unreachable in the shipped app.
    expect(surface.status.kind).toBe("saved");
    expect(surface.status.detail).toContain("version 7");
    expect(surface.coordinator.view.breakdown.remote).toContain("committed as document version 7");
  });

  it("2. an edit while the commit is in flight leaves the watermark at the committed revision", async () => {
    const surface = new Surface();
    await surface.open();
    await surface.editTo(12);

    let inFlight!: () => void;
    const gate = new Promise<void>((resolve) => {
      inFlight = resolve;
    });
    const { ports: p } = ports(surface, {
      documentId: "doc-1",
      commit: async (documentId) => {
        await gate;
        return { documentId, serverVersion: 7, documentRevision: 11 };
      },
    });
    const running = commitToWorkspace(p);
    await settle();

    // The user keeps working while the request is open.
    await surface.edit();
    inFlight();
    await running;
    await settle();

    expect(surface.exported).toEqual([12]);
    expect(surface.state.currentRevision).toBe(13);
    expect(surface.state.lastCommittedRevision).toBe(12);
    expect(surface.state.committedServerVersion).toBe(7);
    // The whole point: revision 13 was NOT committed and nothing may say it was.
    expect(surface.status.detail).not.toContain("version 7");
    expect(surface.status.detail).not.toMatch(/saved to your workspace/i);
  });

  it("3. a commit response that lands after a newer one cannot regress the committed state", async () => {
    const surface = new Surface();
    await surface.open();
    await surface.editTo(12);

    // Two saves in flight; the SECOND resolves first, so the first is stale on
    // arrival. Serialised through the reducer's own scope/frontier fence — there is
    // no second race mechanism.
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = commitToWorkspace({
      ...ports(surface, { documentId: "doc-1" }).ports,
      commit: async (documentId) => {
        await held;
        return { documentId, serverVersion: 7, documentRevision: 11 };
      },
    });
    await settle();
    await surface.edit();
    const { ports: p2 } = ports(surface, { documentId: "doc-1" });
    await commitToWorkspace({
      ...p2,
      commit: async (documentId) => ({ documentId, serverVersion: 8, documentRevision: 12 }),
    });
    await settle();
    expect(surface.state.lastCommittedRevision).toBe(13);
    expect(surface.state.committedServerVersion).toBe(8);

    releaseFirst();
    await first;
    await settle();

    // The older response quoted revision 12 and version 7. Neither may win.
    expect(surface.state.lastCommittedRevision).toBe(13);
    expect(surface.state.committedServerVersion).toBe(8);
    expect(surface.state.staleResponsesIgnored).toBeGreaterThan(0);
  });

  it("4. a failed commit leaves the committed state exactly where it was", async () => {
    const surface = new Surface();
    await surface.open();
    await surface.editTo(4);

    const { ports: p } = ports(surface, {
      documentId: "doc-1",
      commit: async () => {
        throw new Error("500");
      },
    });
    await expect(commitToWorkspace(p)).rejects.toThrow("500");
    await settle();

    expect(surface.state.lastCommittedRevision).toBe(NOTHING_DURABLE);
    expect(surface.state.committedServerVersion).toBeNull();
    expect(surface.status.detail).not.toMatch(/version/i);
    // Anti-vacuity: the same ports SUCCEEDING do move the watermark, so the
    // assertions above are about the failure and not about an inert fixture.
    const { ports: ok } = ports(surface, { documentId: "doc-1" });
    await commitToWorkspace(ok);
    await settle();
    expect(surface.state.lastCommittedRevision).toBe(4);
  });

  it("5. saving three times keeps one document while the revision and the server's version advance", async () => {
    const surface = new Surface();
    await surface.open();
    await surface.editTo(4);

    const created: string[] = [];
    const commits: Array<{
      documentId: string;
      revision: number;
      scene: SerializedEditorState;
      sourceBytes: Uint8Array | null;
    }> = [];
    const harness = ports(surface, {
      documentId: null,
      create: async () => {
        created.push("doc-1");
        // The create route names neither: ingestion writes version 1 asynchronously
        // and moves the revision with it, so there is nothing authoritative to quote
        // yet. The version commit that follows reads both.
        return { documentId: "doc-1", serverVersion: null, documentRevision: null };
      },
      commit: async (documentId, scene, sourceBytes) => {
        commits.push({ documentId, revision: surface.state.currentRevision, scene, sourceBytes });
        // NOT consecutive on purpose: version numbers are the server's to choose
        // and a client that assumed N+1 would be inventing one.
        return {
          documentId,
          serverVersion: commits.length === 1 ? 4 : commits.length === 2 ? 7 : 9,
          documentRevision: commits.length === 1 ? 6 : commits.length === 2 ? 11 : 14,
        };
      },
    });

    await commitToWorkspace(harness.ports);
    await settle();
    expect(created).toEqual(["doc-1"]);
    expect(harness.documentId()).toBe("doc-1");
    /*
     * PHASE 3 CHANGE, deliberate: a FIRST save now creates the document and then
     * publishes a version of it, because `create` hands the upload to asynchronous
     * ingestion and there is no request in that route where the editable scene can
     * ride along. Before this, a first save reported success while storing only
     * flattened bytes — so reopening the document re-imported its own export and
     * every object came back as whatever pdf.js could see. The watermark advances
     * only after the version that carries the scene is acknowledged.
     */
    expect(commits.map((c) => c.documentId)).toEqual(["doc-1"]);
    expect(surface.state.lastCommittedRevision).toBe(4);
    expect(surface.state.committedServerVersion).toBe(4);

    await surface.edit();
    await commitToWorkspace(harness.ports);
    await settle();
    await surface.edit();
    await commitToWorkspace(harness.ports);
    await settle();

    // One document throughout — no second create, no second record.
    expect(created).toEqual(["doc-1"]);
    expect(commits.map((c) => c.documentId)).toEqual(["doc-1", "doc-1", "doc-1"]);
    expect(surface.state.lastCommittedRevision).toBe(6);
    // The LATEST authoritative version, whatever number the server chose.
    expect(surface.state.committedServerVersion).toBe(9);
    expect(surface.status.detail).toContain("version 9");
    expect(surface.exported).toEqual([4, 5, 6]);

    /*
     * Every version carried the editable scene of the revision that was exported,
     * and the pages that scene sits on. This is the assertion the recording defect
     * would have failed: publishing bytes alone made a Workspace version
     * unreopenable as an editing session.
     */
    expect(commits.map((c) => (c.scene.document as { revision: number }).revision)).toEqual([
      4, 5, 6,
    ]);
    expect(commits.every((c) => c.sourceBytes === SOURCE_BYTES)).toBe(true);
  });

  it("6. a first save whose version commit fails reports failure and keeps the document it created", async () => {
    const surface = new Surface();
    await surface.open();
    await surface.editTo(4);

    /*
     * The convergence property for the two-request first save: the CAS on the
     * document's revision can be lost to the ingestion job still cutting version 1,
     * and when it is, the save must (a) report failure rather than a watermark it
     * did not earn, and (b) leave the session OWNING the document, so Retry
     * publishes a version of it instead of creating a second document.
     */
    let attempt = 0;
    const created: string[] = [];
    const harness = ports(surface, {
      documentId: null,
      create: async () => {
        created.push("doc-1");
        return { documentId: "doc-1", serverVersion: null, documentRevision: null };
      },
      commit: async (documentId) => {
        attempt += 1;
        if (attempt === 1) throw new Error("409");
        return { documentId, serverVersion: 2, documentRevision: 5 };
      },
    });

    await expect(commitToWorkspace(harness.ports)).rejects.toThrow("409");
    await settle();
    expect(harness.documentId()).toBe("doc-1");
    expect(surface.state.lastCommittedRevision).toBe(NOTHING_DURABLE);
    expect(surface.state.committedServerVersion).toBeNull();

    // Retry: no second document, and the version is published this time.
    await commitToWorkspace(harness.ports);
    await settle();
    expect(created).toEqual(["doc-1"]);
    expect(surface.state.lastCommittedRevision).toBe(4);
    expect(surface.state.committedServerVersion).toBe(2);
  });
});

describe("the surface pairs the exported bytes with the revision that produced them", () => {
  /**
   * A source-text assertion, and the only place this can be made: `EditorWorkspace`
   * is a React component with a canvas under it, so no Node test can render it. The
   * rule it pins is the one mutation that would otherwise be invisible — reading a
   * LIVE revision inside `exportBytes` (`service.revision`) instead of the
   * render-time value would commit whatever the user reached while the request was
   * open, and every assertion above would still pass because the fake surface reads
   * its revision at issuance.
   */
  it("returns the render-time revision, never a live one read after the export", () => {
    const code = readFileSync("components/editor/EditorWorkspace.tsx", "utf8");
    const start = code.indexOf("handleRef.current = {");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("\n  }", start));
    // Guards the slice: an empty body would satisfy every `not.toContain` below.
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("bytes: await exportEditorPdf(state, sourceBytes ?? undefined)");
    // The PERSISTENCE revision, read before the export awaits — not the editor's
    // history counter (a different domain) and not a live read afterwards.
    expect(body).toContain("const revision = persistenceRef.current.view?.state.currentRevision ?? -1;");
    expect(body).not.toContain("service.revision");
    /*
     * Phase 3: the SCENE is read in the same tick, before the export awaits, and
     * from the editor's own canonical serializer. Reading it after the await would
     * publish a scene of a document the user had already edited past; hand-building
     * an envelope here would fork the codec.
     */
    const sceneAt = body.indexOf("const scene = actions.serialize();");
    expect(sceneAt).toBeGreaterThan(-1);
    expect(sceneAt).toBeLessThan(body.indexOf("await exportEditorPdf"));
    expect(body).toContain("const sourceBytes = sourceBytesRef.current;");
    // And the commit acknowledgement is forwarded to the canonical coordinator
    // rather than interpreted here.
    expect(body).toContain("noteVersionCommitted: (committed) =>");
    expect(body).toContain("persistenceRef.current.noteVersionCommitted(committed)");
  });

  it("has a production caller for noteVersionCommitted, on the success path only", () => {
    /*
     * The defect itself, pinned where it happened. The ledger recorded
     * "`noteVersionCommitted` has no production caller" — a green suite of 6670
     * tests said nothing about it, because every one of them built the event by
     * hand.
     */
    const logic = readFileSync("components/editor/standaloneShellLogic.ts", "utf8");
    /*
     * ONE call site since Phase 3 — down from two. A first save no longer
     * acknowledges its `create`; it creates the document and then publishes a
     * version carrying the editable scene, and only that version's acknowledgement
     * advances the watermark. Two call sites would mean a path where "saved" can be
     * true of a version that stored flattened bytes alone.
     */
    expect(logic.match(/ports\.noteVersionCommitted\(/g)?.length).toBe(1);
    const shell = readFileSync("components/editor/StandaloneEditorShell.tsx", "utf8");
    expect(shell).toContain("noteVersionCommitted: (committed) => surface.noteVersionCommitted(committed)");
    /*
     * Nothing in the save handler's catch may acknowledge anything. Anchored INSIDE
     * the handler rather than on the file's first `catch`, which belongs to the
     * handoff effect above it — an anchor that drifts to an unrelated block is how a
     * source-text test starts asserting about code it was never written about.
     */
    const saveAt = shell.indexOf("const onSaveToWorkspace");
    expect(saveAt).toBeGreaterThan(-1);
    const catchAt = shell.indexOf("} catch (error) {", saveAt);
    expect(catchAt).toBeGreaterThan(saveAt);
    expect(shell.slice(catchAt)).not.toContain("noteVersionCommitted(");
  });
});
