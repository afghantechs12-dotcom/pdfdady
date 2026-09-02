import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitToWorkspace,
  type WorkspaceCommitAck,
  type WorkspaceCommitPorts,
} from "@/components/editor/standaloneShellLogic";
import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";

/**
 * T8–T11: publishing a version from the WORKSPACE editor.
 *
 * The defect this file exists for (F): `DocumentWorkbench` mounted `EditorWorkspace`
 * with no `handleRef`, so `exportBytes` and `noteVersionCommitted` had no caller in
 * the Workspace chrome at all. A document could be opened, edited, and autosaved as
 * a draft, and no version could ever be published. Every unit involved was correct
 * and tested; the wire was missing. So half of this file asserts on source text —
 * `DocumentWorkbench.tsx` cannot be rendered here (Node, no jsdom, and the editor
 * wants PDF.js and a layout engine) — and that half is the half that would have
 * caught it.
 *
 * The other half drives the REAL orchestrator with the REAL port set the workbench
 * assigns, because the requirement is not "a publish button exists" but "publishing
 * from the workbench means exactly what publishing from the standalone shell means".
 * There is no second save system to test: `commitToWorkspace` is the ordering rule
 * for both surfaces, and what differs is only which ports are handed to it.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/**
 * Comments removed before every source assertion. Several calls asserted ABSENT
 * below are named in the comments explaining why they are absent, and a warning
 * about a call must never read as the call.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const button = stripComments(read("components", "workspaces", "PublishVersionButton.tsx"));
const workbench = stripComments(read("components", "workspaces", "DocumentWorkbench.tsx"));

const SCENE: SerializedEditorState = {
  format: "pdfdadi-editor",
  version: 6,
  document: { pages: [{ id: "page-1", objects: [] }] },
  activePageId: "page-1",
  selection: { objectIds: [] },
};

const DOCUMENT_ID = "doc-already-in-the-workspace";

/**
 * The workbench's port set, with the transport replaced.
 *
 * `existingDocumentId` always answers and `create` throws — not as a convenience of
 * the test but as a copy of what the production hook assigns, which is the whole
 * reason a workbench publish cannot produce a second document for a document that
 * is already open.
 */
function workbenchPorts(options: {
  revisions: number[];
  commit?: (documentId: string) => Promise<WorkspaceCommitAck>;
}) {
  const calls = {
    creates: 0,
    commits: [] as { documentId: string; scene: SerializedEditorState }[],
    acknowledged: [] as { revision: number; serverVersion: number | null }[],
  };
  let exportIndex = 0;
  const ports: WorkspaceCommitPorts = {
    exportBytes: async () => ({
      bytes: new Uint8Array([37, 80, 68, 70]),
      revision: options.revisions[exportIndex++] ?? 0,
      scene: SCENE,
      sourceBytes: new Uint8Array([37, 80, 68, 70, 45, 49]),
    }),
    existingDocumentId: () => DOCUMENT_ID,
    create: () => {
      calls.creates += 1;
      throw new Error("a workbench publish never creates a document");
    },
    commit: async (documentId, _bytes, scene) => {
      calls.commits.push({ documentId, scene });
      return options.commit
        ? await options.commit(documentId)
        : { documentId, serverVersion: calls.commits.length, documentRevision: 40 + calls.commits.length };
    },
    onDocumentCreated: () => {},
    noteVersionCommitted: ({ revision, serverVersion }) =>
      calls.acknowledged.push({ revision, serverVersion }),
  };
  return { ports, calls };
}

describe("T8 — publishing from the Workspace editor", () => {
  it("publishes a version of the document already open, and never creates one", async () => {
    const { ports, calls } = workbenchPorts({ revisions: [7] });
    await commitToWorkspace(ports);
    expect(calls.creates).toBe(0);
    expect(calls.commits).toHaveLength(1);
    expect(calls.commits[0]?.documentId).toBe(DOCUMENT_ID);
    // Phase 3: the version carries the editable scene, not flattened output alone.
    expect(calls.commits[0]?.scene).toEqual(SCENE);
    // Phase 2: the watermark advances to the revision the EXPORT was taken at.
    expect(calls.acknowledged).toEqual([{ revision: 7, serverVersion: 1 }]);
  });
});

describe("T9 — publishing twice", () => {
  it("makes two versions of ONE document, with no second document anywhere", async () => {
    const { ports, calls } = workbenchPorts({ revisions: [7, 9] });
    await commitToWorkspace(ports);
    await commitToWorkspace(ports);
    expect(calls.creates).toBe(0);
    expect(calls.commits.map((c) => c.documentId)).toEqual([DOCUMENT_ID, DOCUMENT_ID]);
    expect(calls.acknowledged).toEqual([
      { revision: 7, serverVersion: 1 },
      { revision: 9, serverVersion: 2 },
    ]);
  });

  it("releases the double-click guard in a finally, so a second publish is possible at all", () => {
    /*
     * The guard is a ref, set before the first await: two clicks in one tick read
     * the same rendered state, so a state flag would let the second issue a second
     * version of identical bytes. The risk of a ref is the opposite one — a guard
     * left set disables the button's action for the life of the pane — which is why
     * the release is asserted to be in a `finally` rather than merely present.
     */
    expect(button).toContain("if (surface === null || inFlightRef.current) return;");
    const guardAt = button.indexOf("inFlightRef.current = true;");
    const exportAt = button.indexOf("commitToWorkspace({");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(exportAt);
    const finallyAt = button.indexOf("} finally {");
    expect(finallyAt).toBeGreaterThan(exportAt);
    expect(button.slice(finallyAt)).toContain("inFlightRef.current = false;");
  });
});

describe("T10 — an edit made while a publish is in flight", () => {
  it("acknowledges the exported revision, leaving the newer edit unsaved", async () => {
    /*
     * The revision advances between the export and the response — a keystroke while
     * the request is in the air. The acknowledgement must still name the revision
     * that was published; naming the current one is how an editor reports "saved"
     * about an edit that never left the browser.
     */
    let current = 7;
    const { ports, calls } = workbenchPorts({
      revisions: [7],
      commit: async (documentId) => {
        current = 8;
        return { documentId, serverVersion: 1, documentRevision: 41 };
      },
    });
    await commitToWorkspace(ports);
    expect(current).toBe(8);
    expect(calls.acknowledged).toEqual([{ revision: 7, serverVersion: 1 }]);
  });
});

describe("T11 — a publish that fails", () => {
  it("acknowledges nothing, and hands the failure to the caller", async () => {
    const { ports, calls } = workbenchPorts({
      revisions: [7],
      commit: async () => {
        throw new Error("409");
      },
    });
    await expect(commitToWorkspace(ports)).rejects.toThrow("409");
    // The one error direction that produces a false "saved" is an advanced
    // watermark. There is none, so the editing state stays dirty and retryable.
    expect(calls.acknowledged).toEqual([]);
  });

  it("banners the failure through the canonical classification and marks nothing saved", () => {
    const catchAt = button.indexOf("} catch (error) {");
    expect(catchAt).toBeGreaterThan(-1);
    const handler = button.slice(catchAt, button.indexOf("} finally {"));
    // Same classified copy as the standalone shell, so a conflict reads identically
    // in both surfaces rather than being described twice.
    expect(handler).toContain("workspaceSaveFailureMessage(error.failure)");
    expect(handler).toContain("onFailure(");
    expect(handler).not.toContain("noteVersionCommitted");
    // And no success copy anywhere: a published version is reported by the
    // canonical save readout inside the editor, which is the same projection the
    // tab's unsaved dot reads. A local "Published!" beside it would be a second
    // answer to "is my work safe".
    expect(button).not.toContain("Published!");
    expect(button.toLowerCase()).not.toContain("saved to workspace as");
  });
});

describe("the wire itself — defect F", () => {
  it("assigns the ports rather than restating the save rules", () => {
    expect(button).toContain("await commitToWorkspace({");
    expect(button).toContain("existingDocumentId: () => documentId,");
    expect(button).toContain("saveWorkspaceVersion({ workspaceId, organizationId }, id, {");
    expect(button).toContain("noteVersionCommitted: (committed) => surface.noteVersionCommitted(committed)");
    // The create branch is unreachable by construction, and says so by throwing:
    // a workbench publish that created a document would be duplicating the document
    // it is editing.
    expect(button).toContain('throw new Error("a workbench publish never creates a document")');
    // No second naming policy, and no suffix — a new version of `report.pdf` is
    // `report.pdf`, not `report.pdf.pdf` and not `report-edited.pdf`.
    expect(button).toContain('outputFileName({ sources: [documentName], ext: "pdf" })');
    expect(button).not.toContain('suffix:');
  });

  it("passes the handle and the status projection at BOTH workbench editor mounts", () => {
    /*
     * The defect, pinned where it happened. Before this phase both mounts read
     * `<EditorWorkspace document={...} />` with neither prop, so every assertion in
     * this test would have failed — which is what makes them non-vacuous.
     *
     * Both mounts, because the second is not a duplicate: it is what a writer whose
     * session bootstrap failed gets, and an editor that cannot publish is the dead
     * end this phase is about.
     */
    expect(workbench.match(/handleRef=\{[a-zA-Z]*[pP]ublish\.surfaceRef\}/g)).toHaveLength(2);
    expect(workbench.match(/onSaveStatusChange=\{[a-zA-Z]*[pP]ublish\.onSaveStatus\}/g)).toHaveLength(2);
    expect(workbench.match(/<PublishVersionButton publish=/g)).toHaveLength(2);
  });

  it("shows the control only to an actor who may write, and only for a real document", () => {
    // Not the authorization — the version route re-checks membership regardless of
    // what renders. This is about not offering an action that must fail.
    expect(workbench).toContain("{canWrite && active ? <PublishVersionButton publish={publish} /> : null}");
    expect(workbench).toContain("canWrite={canWrite}");
  });

  it("derives readiness from the canonical projection, not from a local flag", () => {
    /*
     * `idle` is the projection's "nothing is open" — what a mounted editor reports
     * until its load finishes and arms persistence. Gating on it is what stops a
     * click during load from exporting the editor's default blank page and
     * publishing it as a version of a real document.
     */
    expect(button).toContain('ready: live?.status != null && live.status.kind !== "idle"');
    expect(button).toContain("onSaveStatus");
    expect(button).toContain("disabled={!publish.ready || publish.publishing}");
  });

  it("scopes its state to one document, so a tab switch cannot publish against another", () => {
    // A pane outlives its tabs: the editor is keyed on the tab and remounts, the
    // hook does not. Without the comparison, a tab switch would leave the previous
    // document's "ready" on a button that now points somewhere else.
    expect(button).toContain("const live = session.documentId === documentId ? session : null;");
    // The surface is captured BEFORE the export, so an acknowledgement cannot move a
    // different document's watermark if the user switches tabs mid-publish.
    const surfaceAt = button.indexOf("const surface = surfaceRef.current;");
    expect(surfaceAt).toBeGreaterThan(-1);
    expect(surfaceAt).toBeLessThan(button.indexOf("await commitToWorkspace({"));
    expect(button).not.toContain("surfaceRef.current.noteVersionCommitted");
  });

  it("uses the phase's copy, exactly", () => {
    expect(button).toContain('"Publish version"');
    expect(button).toContain("Publishing\u2026");
  });
});
