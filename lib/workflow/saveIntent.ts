/**
 * The client half of save identity: one opaque key per save INTENTION.
 *
 * A key exists so that a save can be repeated without being repeated. The retry
 * after a lost response, the second press of a button whose first press is still
 * in flight, a remount that puts the same result back on screen — all of those are
 * one intention, and they carry one key, so the server answers all of them with
 * the one document the first of them made.
 *
 * What a key is NOT is authorization. It is presented alongside a session and a
 * destination the server re-checks in full, and it is scoped to the actor who
 * presented it, so a key that leaks is a key that does nothing.
 *
 * Two different intentions must never share one, which is why nothing here is
 * derived from the file: not its name (renamed, retyped, shared) and not its bytes
 * (deliberately saving one file twice is exactly the case that has to produce two
 * documents). A key is random, and its lifetime is the result it belongs to.
 */

/**
 * A fresh intention.
 *
 * `crypto.randomUUID` where it exists — every browser this product supports, and
 * Node for the tests. The fallback is for a non-secure context, where the API is
 * absent: a key only has to be unguessable and unique among this user's own keys,
 * and `Math.random` plus a timestamp clears that bar. It is never a secret.
 */
export function newSaveIntentKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `si-${uuid}`;
  return `si-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The same intention, aimed at one DESTINATION.
 *
 * A destination is part of what a save means, and the server refuses one key that
 * arrives with two of them — otherwise "save this into Home" and "save this into
 * Team" would be one operation, and the second would be answered with the first
 * one's document in a Workspace the user did not pick. Saving one result into two
 * Workspaces is two intentions, so it is two keys, both derived from the one the
 * result carries: a retry of either still converges, because the destination that
 * produced the key is the destination being retried.
 *
 * Characters outside the key alphabet are dropped rather than sent to be refused;
 * a Workspace id is a cuid, so nothing is normally dropped.
 */
export function saveIntentKeyForTarget(base: string, workspaceId: string): string {
  return `${base}.${workspaceId.replace(/[^A-Za-z0-9_.:@-]/gu, "")}`;
}

/**
 * The intention for saving a SERVER job's result — stable for as long as that
 * result is.
 *
 * A local result lives in the page, so its key can live beside it in React state.
 * A job's result lives on the server and outlives the page: the user can reload,
 * come back to the job and press Save again, and that is the same intention as
 * before, not a second one. So the key is remembered per job.
 *
 * `sessionStorage` is per-tab and cleared with it, which matches how long a job
 * result is interesting. The in-module map in front of it is what makes a remount
 * free, and the fallback when storage is blocked entirely: a fresh key then costs
 * a duplicate document in the reload case, which is worse than remembering and far
 * better than refusing to save.
 */
const jobKeys = new Map<string, string>();

export function saveIntentKeyForJob(jobId: string): string {
  const cached = jobKeys.get(jobId);
  if (cached) return cached;
  const slot = `pdfdadi.saveIntent.job.${jobId}`;
  let key: string | null = null;
  try {
    key = globalThis.sessionStorage?.getItem(slot) ?? null;
  } catch {
    // Storage disabled for this site. Not an error worth surfacing.
  }
  if (!key) {
    key = newSaveIntentKey();
    try {
      globalThis.sessionStorage?.setItem(slot, key);
    } catch {
      // Same: the map below still covers this page's own remounts.
    }
  }
  jobKeys.set(jobId, key);
  return key;
}
