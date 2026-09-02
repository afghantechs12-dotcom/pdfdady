import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_VERSION_REASON,
  DEGRADED_VERSION_REASON,
  READ_ONLY_REASON,
  RESTORE_HELPER_TEXT,
  REVISION_UNKNOWN_REASON,
  expectedRevisionFrom,
  isCurrentVersion,
  restoreAnnouncement,
  restoreEligibility,
  restoreFailure,
} from "./versionRestoreLogic";

/**
 * Version restore (Phase H, B1 / H35–H37).
 *
 * The suite runs in Node with `environment: "node"` and no DOM renderer, so the
 * interactive parts of the panel are covered by asserting on the pure decision
 * module plus the panel's source text. That split is deliberate: the rules worth
 * protecting here are *policy* (where the revision comes from, what a 409 does),
 * and policy is exactly what survives in a pure module.
 *
 * What this canNOT cover, honestly stated: the actual click → fetch → re-render
 * cycle. That is left to the Stage 5 browser probes and human review.
 */

const ROOT = join(__dirname, "..", "..");
const inspectorSource = readFileSync(
  join(ROOT, "components", "workspaces", "DocumentInspector.tsx"),
  "utf8",
);

const doc = (revision: number, currentVersionId: string | null = "v-current") => ({
  revision,
  currentVersionId,
});
const version = (id: string, manifestDegraded = false) => ({ id, manifestDegraded });

describe("expectedRevisionFrom", () => {
  it("reads the revision from the document record", () => {
    expect(expectedRevisionFrom(doc(7))).toBe(7);
  });

  it("accepts revision 0 — a document that has never been versioned is not 'unknown'", () => {
    expect(expectedRevisionFrom(doc(0))).toBe(0);
  });

  it("returns null when the document record is missing, rather than guessing", () => {
    expect(expectedRevisionFrom(null)).toBeNull();
  });

  it("returns null for a revision that the route's schema would refuse anyway", () => {
    expect(expectedRevisionFrom(doc(-1))).toBeNull();
    expect(expectedRevisionFrom(doc(1.5))).toBeNull();
    expect(expectedRevisionFrom({ revision: Number.NaN, currentVersionId: null })).toBeNull();
    // A string revision from a malformed payload must not become `"3"`.
    expect(
      expectedRevisionFrom({ revision: "3", currentVersionId: null } as unknown as {
        revision: number;
        currentVersionId: string | null;
      }),
    ).toBeNull();
  });
});

describe("isCurrentVersion", () => {
  it("uses the document's pointer, not list position", () => {
    expect(isCurrentVersion(version("v-current"), doc(4))).toBe(true);
    expect(isCurrentVersion(version("v-older"), doc(4))).toBe(false);
  });

  it("is false when the document has never pointed at a version", () => {
    expect(isCurrentVersion(version("v1"), doc(0, null))).toBe(false);
  });

  it("is false when the document record is unknown", () => {
    expect(isCurrentVersion(version("v1"), null)).toBe(false);
  });
});

describe("restoreEligibility", () => {
  const base = { document: doc(4), canWrite: true, busy: false };

  it("enables restore for an older, intact version on a writable document", () => {
    expect(restoreEligibility({ ...base, version: version("v-older") })).toEqual({ enabled: true });
  });

  it("disables restore on the current version, with a reason (H36)", () => {
    expect(restoreEligibility({ ...base, version: version("v-current") })).toEqual({
      enabled: false,
      reason: CURRENT_VERSION_REASON,
    });
  });

  it("disables restore on a degraded manifest, matching what the service refuses", () => {
    expect(restoreEligibility({ ...base, version: version("v-older", true) })).toEqual({
      enabled: false,
      reason: DEGRADED_VERSION_REASON,
    });
  });

  it("disables restore when the revision is unknown instead of posting a guess", () => {
    expect(
      restoreEligibility({ ...base, document: null, version: version("v-older") }),
    ).toEqual({ enabled: false, reason: REVISION_UNKNOWN_REASON });
  });

  it("disables restore for a read-only viewer before any other consideration", () => {
    // Even for a row that would otherwise be eligible.
    expect(
      restoreEligibility({ ...base, canWrite: false, version: version("v-older") }),
    ).toEqual({ enabled: false, reason: READ_ONLY_REASON });
  });

  it("reports the permanent reason, not the transient one, when both apply", () => {
    // A degraded row stays explained while a restore is in flight elsewhere.
    expect(
      restoreEligibility({ ...base, busy: true, version: version("v-older", true) }).reason,
    ).toBe(DEGRADED_VERSION_REASON);
  });

  it("disables without a reason while busy — a tooltip on a spinner is noise", () => {
    expect(restoreEligibility({ ...base, busy: true, version: version("v-older") })).toEqual({
      enabled: false,
    });
  });
});

describe("restoreFailure", () => {
  it("surfaces the server's own 409 message verbatim", () => {
    const message =
      "Document revision 9 does not match the expected revision 7. Reload and retry.";
    expect(restoreFailure(409, message)).toEqual({ message, offerReload: true });
  });

  it("offers a manual reload on 409 and never signals an automatic retry", () => {
    expect(restoreFailure(409, null).offerReload).toBe(true);
  });

  it("falls back to an honest sentence when a 409 carries no body", () => {
    const failure = restoreFailure(409, "");
    expect(failure.message).toContain("Reload");
    expect(failure.offerReload).toBe(true);
  });

  it("treats a vanished version as stale state worth reloading", () => {
    expect(restoreFailure(404, null)).toEqual({
      message: "That version no longer exists.",
      offerReload: true,
    });
  });

  it("does not offer reload for an authorization failure — reloading cannot grant access", () => {
    expect(restoreFailure(403, null).offerReload).toBe(false);
    expect(restoreFailure(401, null).offerReload).toBe(false);
  });

  it("does not offer reload for a server error", () => {
    expect(restoreFailure(500, null)).toEqual({
      message: "The version could not be restored.",
      offerReload: false,
    });
  });

  it("ignores a whitespace-only server message", () => {
    expect(restoreFailure(500, "   ").message).toBe("The version could not be restored.");
  });
});

describe("restore wording is honest about what restore does", () => {
  it("says a new version is created and history is kept", () => {
    expect(RESTORE_HELPER_TEXT).toBe("Creates a new version from this one. History is kept.");
  });

  it("never describes a restore as a rewind, revert or undo", () => {
    // The service creates version N+1 from N's manifest; it does not rewind.
    for (const text of [
      RESTORE_HELPER_TEXT,
      CURRENT_VERSION_REASON,
      DEGRADED_VERSION_REASON,
      restoreAnnouncement(3, 9),
    ]) {
      expect(text).not.toMatch(/rewind|revert|roll ?back|undo/i);
    }
  });

  it("announces both the source and the newly created version", () => {
    expect(restoreAnnouncement(3, 9)).toBe("Restored version 3 as new version 9.");
  });
});

describe("the Versions panel wires restore to the real contract", () => {
  it("reads expectedRevision from the document record, not the version list", () => {
    const restoreBlock = inspectorSource.slice(inspectorSource.indexOf("const restore = useCallback"));
    const body = restoreBlock.slice(0, restoreBlock.indexOf("[base, document, organizationId]"));

    // The binding itself, not merely the presence of the import: an earlier
    // version of this test passed while the body used `version.versionNumber`,
    // because the helper was still referenced in the import list.
    expect(body).toMatch(/const expectedRevision = expectedRevisionFrom\(document\)/);

    // And it must be posted, not just computed.
    expect(body).toMatch(/expectedRevision\s*[,}]/);

    // Nothing version-shaped may be bound to it. The per-version `revision` is
    // always one behind the document's, so this would 409 on every restore.
    expect(body).not.toMatch(/expectedRevision[^;\n]*\bversion\b/);
    expect(body).not.toMatch(/expectedRevision:\s*(?!expectedRevision)/);
  });

  it("refuses to post at all when the revision is unknown", () => {
    const restoreBlock = inspectorSource.slice(inspectorSource.indexOf("const restore = useCallback"));
    const body = restoreBlock.slice(0, restoreBlock.indexOf("[base, document, organizationId]"));
    // A guessed revision would either fail confusingly or, worse, land.
    expect(body).toMatch(/if \(expectedRevision === null\) return/);
    // The guard must precede the fetch, not follow it.
    expect(body.indexOf("expectedRevision === null")).toBeLessThan(body.indexOf("fetch("));
  });

  it("fetches the document record alongside the version list", () => {
    const restoreBlock = inspectorSource.slice(inspectorSource.indexOf("function VersionsTab"));
    // Two reads. The list, and the document record itself — the same route
    // family with NO trailing sub-path, which is what carries `revision`.
    expect(restoreBlock).toContain("`${base}/versions?${query}`");
    expect(restoreBlock).toContain("`${base}?${query}`");
    // `base` must be the document route, so the bare fetch above is the record.
    expect(restoreBlock).toMatch(/const base =[\s\S]*?documents\/\$\{encodeURIComponent\(/);
    expect(restoreBlock).toContain("record.revision");
  });

  it("posts the restore to the versions restore endpoint", () => {
    expect(inspectorSource).toContain("/restore");
    expect(inspectorSource).toMatch(/method:\s*"POST"/);
  });

  it("delegates the failure message to restoreFailure rather than inventing one", () => {
    expect(inspectorSource).toContain("restoreFailure");
  });

  it("never re-posts a restore automatically after a conflict", () => {
    // A retry loop would defeat the compare-and-swap. The only recovery path is
    // the user pressing "Reload versions" and deciding again.
    const restoreBlock = inspectorSource.slice(inspectorSource.indexOf("function VersionsTab"));
    expect(restoreBlock).not.toMatch(/setTimeout|retryRestore|attemptRestore\s*\(/);
    expect(restoreBlock).toContain("Reload versions");
  });

  it("keeps the disabled reason on the control so it is discoverable (H24)", () => {
    const restoreBlock = inspectorSource.slice(inspectorSource.indexOf("function VersionsTab"));
    expect(restoreBlock).toContain("restoreEligibility");
    expect(restoreBlock).toMatch(/title=\{[^}]*reason/);
  });

  it("does not offer Preview or Compare, which have no endpoint", () => {
    const restoreBlock = inspectorSource.slice(inspectorSource.indexOf("function VersionsTab"));
    expect(restoreBlock).not.toMatch(/>\s*Preview\s*</);
    expect(restoreBlock).not.toMatch(/>\s*Compare\s*</);
  });

  it("shows a local skeleton and never remounts the editor (H37)", () => {
    // The tab owns its own busy state; nothing here touches a document key or
    // forces a remount of the surrounding editor.
    const restoreBlock = inspectorSource.slice(inspectorSource.indexOf("function VersionsTab"));
    expect(restoreBlock).toMatch(/restoring/);
    expect(restoreBlock).not.toMatch(/location\.reload|window\.location/);
  });
});
