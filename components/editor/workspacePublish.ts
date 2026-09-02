/**
 * Publishing an editing session INTO a Workspace: the four requests that do it.
 *
 * Extracted from `StandaloneEditorShell` unchanged (bar the revision the version
 * route now reports) because a second surface needs the identical semantics: the
 * Workspace workbench publishes the document it already has open. Two copies of
 * "which revision do I compare-and-swap against" is two places for one of them to
 * be wrong, and the wrong one loses a user's version.
 *
 * The pure half — what a failure MEANS, and the order the two requests run in —
 * stays in `standaloneShellLogic`, which is unit tested without a DOM. This module
 * is only the transport: it holds every `fetch`, and nothing that needs a decision.
 */

import {
  classifyWorkspaceSaveFailure,
  type WorkspaceCommitAck,
  type WorkspaceSaveFailure,
} from "@/components/editor/standaloneShellLogic";

/**
 * Where a publish writes. Structural on purpose: the standalone shell's
 * `SaveTarget` and a tool result's `ResultSaveTarget` both satisfy it, and neither
 * has to be imported here to do so.
 */
export interface PublishTarget {
  workspaceId: string;
  organizationId: string;
}

/**
 * A save failure, carried as a CATEGORY rather than the server's sentence.
 *
 * The server's messages are written for an API consumer — "Document revision 4
 * does not match the expected revision 3" — and the banner must not put a
 * revision number in front of a user. Classification is pure and unit tested in
 * `standaloneShellLogic`; this class only carries the result across the throw.
 */
export class WorkspaceSaveError extends Error {
  constructor(readonly failure: WorkspaceSaveFailure) {
    super(`workspace save failed: ${failure}`);
    this.name = "WorkspaceSaveError";
  }
}

/** Classifies a non-OK response. A body that is not JSON still yields a category. */
export async function failureFor(res: Response): Promise<WorkspaceSaveError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return new WorkspaceSaveError(
    classifyWorkspaceSaveFailure(res.status, body?.error?.code ?? null),
  );
}

/**
 * The FIRST save of an editing session: creates the Workspace document and returns
 * its id, or null when the response did not name one (in which case the next save
 * cannot update it — the banner then links to the Workspace rather than the file).
 */
export async function createWorkspaceDocument(
  target: PublishTarget,
  blob: Blob,
  fileName: string,
): Promise<WorkspaceCommitAck> {
  const form = new FormData();
  form.append("file", blob, fileName);
  form.append("name", fileName);
  form.append("organizationId", target.organizationId);
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(target.workspaceId)}/documents/upload`,
    { method: "POST", body: form },
  );
  if (!res.ok) throw await failureFor(res);
  const data = (await res.json().catch(() => null)) as { document?: { id?: string } } | null;
  /*
   * No version number, deliberately: this route returns before ingestion has
   * created version 1 (`DocumentIngestionService` does it asynchronously, with
   * origin `import`), so there is nothing authoritative to quote. Reporting null
   * records the commit's revision without inventing a version — the next save,
   * which goes through the version route, is the first that can name one. The
   * revision is null for the same reason: ingestion is about to move it.
   */
  return { documentId: data?.document?.id ?? null, serverVersion: null, documentRevision: null };
}

/**
 * How long the version commit waits for a just-created document's import to land,
 * and how often it looks. Well inside a first save's own latency budget, and
 * skipped entirely for a document that already has a version.
 */
export const IMPORT_SETTLE_TIMEOUT_MS = 6000;
export const IMPORT_SETTLE_INTERVAL_MS = 200;

/**
 * The revision to compare-and-swap against, read once our OWN import can no
 * longer move it.
 *
 * A first save is two requests — create, then the version commit — and the
 * upload's asynchronous ingestion cuts version 1 in between, bumping the revision
 * with the very same write that sets `currentVersionId`. Reading the revision
 * before that landed made the CAS lose to our own import job, so a user's FIRST
 * save reported a conflict about a document nobody else had touched.
 *
 * Waiting for the pointer is not a substitute for the compare-and-swap: the
 * server still checks, another tab's save still conflicts, this makes no second
 * attempt at a rejected write, and a document whose ingestion never completes
 * falls through after the bound with the revision it has. The second save of a
 * session sees a pointer already set and costs exactly the one read it always did.
 */
export async function revisionForCommit(base: string, query: string): Promise<number> {
  const deadline = Date.now() + IMPORT_SETTLE_TIMEOUT_MS;
  for (;;) {
    const current = await fetch(`${base}?${query}`, { headers: { Accept: "application/json" } });
    if (!current.ok) throw await failureFor(current);
    const body = (await current.json().catch(() => null)) as
      | { document?: { revision?: number; currentVersionId?: string | null } }
      | null;
    const revision = body?.document?.revision;
    if (typeof revision !== "number") throw new WorkspaceSaveError("unknown");
    if (body?.document?.currentVersionId || Date.now() >= deadline) return revision;
    await new Promise((resolve) => setTimeout(resolve, IMPORT_SETTLE_INTERVAL_MS));
  }
}

/**
 * A save of an existing document: a new version of it, carrying the flattened
 * bytes it publishes, the editable scene it was saved from, and the original pages
 * that scene sits on.
 *
 * All three, because publishing bytes alone is what made a Workspace version
 * unreopenable: the editor could only re-import the flattened export, so a sticky
 * note came back as extracted source text with no panel. The three artifacts are
 * kept DISTINCT rather than derived from one another — the exported PDF is never
 * reverse-parsed to recover editor state.
 *
 * The revision is read immediately before the write rather than remembered from
 * the previous save, because another tab may have saved in between — see
 * `revisionForCommit` for why that read also waits out our own import job.
 */
export async function saveWorkspaceVersion(
  target: PublishTarget,
  documentId: string,
  artifacts: {
    /** The flattened PDF this version publishes. */
    output: Blob;
    fileName: string;
    /** The serialized editor scene, so the version reopens as this session. */
    scene: string;
    /** The pages the scene sits on, or null for a document with no source PDF. */
    source: Blob | null;
  },
): Promise<WorkspaceCommitAck> {
  const base = `/api/workspaces/${encodeURIComponent(target.workspaceId)}/documents/${encodeURIComponent(documentId)}`;
  const query = `organizationId=${encodeURIComponent(target.organizationId)}`;
  const revision = await revisionForCommit(base, query);

  const form = new FormData();
  form.append("file", artifacts.output, artifacts.fileName);
  form.append("expectedRevision", String(revision));
  form.append("organizationId", target.organizationId);
  /*
   * The two parts that make this version REOPENABLE as an editing session rather
   * than re-importable as its own flattened output. `source` is re-sent every save
   * even though it does not change: object storage is content-addressed and
   * byte-deduplicated, so the second save of a session stores no new original bytes.
   */
  form.append("scene", artifacts.scene);
  if (artifacts.source !== null) form.append("source", artifacts.source, "source.pdf");
  const res = await fetch(`${base}/versions/upload`, { method: "POST", body: form });
  if (!res.ok) throw await failureFor(res);
  /*
   * The AUTHORITATIVE version number AND the revision this write produced, both
   * read from the response the server just wrote — not from the revision above,
   * not from a client counter. The route returns `DocumentVersionResponse`, which
   * names the version and withholds every artifact storage key, so nothing
   * internal is read here.
   *
   * The revision is the session's next compare-and-swap token. Deriving it as
   * `revision + 1` would be arithmetic on a column this client does not own, and
   * reusing the version number for it — which is what this returned before —
   * makes the session's next autosave conflict with the version it just published.
   */
  const created = (await res.json().catch(() => null)) as
    | { version?: { versionNumber?: number }; document?: { revision?: number } }
    | null;
  const versionNumber = created?.version?.versionNumber;
  const documentRevision = created?.document?.revision;
  return {
    documentId,
    serverVersion: typeof versionNumber === "number" ? versionNumber : null,
    documentRevision: typeof documentRevision === "number" ? documentRevision : null,
  };
}
