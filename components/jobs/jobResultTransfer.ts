/**
 * How a CLOUD result moves — the two transfers, in one place, for both server
 * result surfaces (`JobStatePanel` for the pipeline, `ServerToolRunner` for the
 * rest).
 *
 * They are separate functions because they are genuinely different journeys, and
 * the difference is the whole point of the phase:
 *
 *  - `Open in Editor` needs the bytes IN THE PAGE, so they are streamed to the
 *    browser from this origin.
 *  - `Save to Workspace` needs the bytes IN A WORKSPACE, so they never come to
 *    the browser at all: the request carries two ids and the server copies
 *    storage-to-storage.
 *
 * Neither runs until the user presses the button.
 */

import type { ResultSaveTarget } from "@/components/tools/resultWorkflow";
import { saveIntentKeyForJob, saveIntentKeyForTarget } from "@/lib/workflow/saveIntent";

/**
 * The result's bytes, for `Open in Editor`.
 *
 * `?inline=1` rather than the default redirect: the redirect points at a signed
 * storage URL, which in production is a different origin, so a `fetch` that
 * followed it would need bucket CORS configured for this site — and would work in
 * development (where the signed URL is a local route) while failing in
 * production. Download keeps using the redirect, so the app server stays out of
 * the data path for the common action.
 */
export async function loadJobResultBytes(jobId: string): Promise<Uint8Array> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/result?inline=1`, {
    headers: { Accept: "application/pdf" },
  });
  if (!res.ok) throw new Error(`result unavailable: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Saves the result into a Workspace WITHOUT sending the bytes: the route reads
 * the output from PDFDadi's own storage and hands it to the same upload service a
 * browser upload goes through.
 *
 * The body is two ids, and both are checked rather than trusted — job ownership
 * for the source, Workspace membership for the destination. No signed URL is
 * accepted as evidence of either, because none is sent.
 *
 * The third field is the save INTENTION, remembered per job and narrowed to this
 * destination, so that a retry after a lost response — or after a reload that brings
 * the user back to the same finished job — is the same intention and answers with the
 * same document, while saving the job into a second Workspace is its own. The server
 * binds it to this job id and to the checksum of the bytes it actually read, so a key
 * minted here for one result cannot be presented for another.
 */
export function saveJobResultToWorkspace(
  jobId: string,
  target: ResultSaveTarget,
): Promise<Response> {
  return fetch(`/api/jobs/${encodeURIComponent(jobId)}/save-to-workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: target.workspaceId,
      organizationId: target.organizationId,
      saveIntentKey: saveIntentKeyForTarget(saveIntentKeyForJob(jobId), target.workspaceId),
    }),
  });
}
