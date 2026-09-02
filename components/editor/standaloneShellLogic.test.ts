import { describe, expect, it } from "vitest";
import {
  GUEST_SAVE_SIGNUP_HREF,
  classifyWorkspaceSaveFailure,
  documentTitle,
  resolveStage,
  shellActions,
  viewerInitials,
  workspaceSaveFailureMessage,
  type ShellViewer,
} from "./standaloneShellLogic";

/**
 * The standalone `/editor` shell. The rules worth pinning are the ones a
 * refactor could silently invert: guests must keep editing, an untouched
 * onboarding document must not be saveable, and the signup link must return the
 * visitor to their unsaved work rather than a dashboard.
 */

const GUEST: ShellViewer = { email: null, name: null };
const USER: ShellViewer = { email: "faisal@example.com", name: "Faisal Arifi" };

describe("resolveStage", () => {
  it("starts in onboarding for a fresh visit", () => {
    expect(resolveStage({ dismissed: false, hasDocument: false })).toBe("onboarding");
  });

  it("moves to editing when the visitor chooses a blank document", () => {
    expect(resolveStage({ dismissed: true, hasDocument: false })).toBe("editing");
  });

  it("moves to editing when a PDF is opened", () => {
    expect(resolveStage({ dismissed: false, hasDocument: true })).toBe("editing");
  });

  it("never returns to onboarding once a document exists", () => {
    // Re-showing the first-run overlay would hide work already on the canvas.
    expect(resolveStage({ dismissed: true, hasDocument: true })).toBe("editing");
  });
});

describe("documentTitle", () => {
  it("falls back to Untitled PDF", () => {
    expect(documentTitle(null)).toBe("Untitled PDF");
    expect(documentTitle("")).toBe("Untitled PDF");
    expect(documentTitle("   ")).toBe("Untitled PDF");
  });

  it("uses the opened file name", () => {
    expect(documentTitle("quarterly-report")).toBe("quarterly-report");
  });
});

describe("shellActions", () => {
  it("lets a guest open a PDF — signed-out editing is supported", () => {
    expect(shellActions(GUEST, "onboarding").openPdf).toBe(true);
    expect(shellActions(GUEST, "editing").openPdf).toBe(true);
  });

  it("offers a guest the Workspace upsell only once they have work", () => {
    expect(shellActions(GUEST, "onboarding").guestSaveUpsell).toBe(false);
    expect(shellActions(GUEST, "editing").guestSaveUpsell).toBe(true);
  });

  it("never offers a guest a save they cannot perform", () => {
    for (const stage of ["onboarding", "editing"] as const) {
      expect(shellActions(GUEST, stage).saveToWorkspace).toBe(false);
    }
  });

  it("offers save to an authenticated user with a Workspace, once editing", () => {
    expect(shellActions(USER, "onboarding", true).saveToWorkspace).toBe(false);
    expect(shellActions(USER, "editing", true).saveToWorkspace).toBe(true);
  });

  it("hides save when the user has no resolvable Workspace", () => {
    // The page degrades to no save target rather than throwing; the shell must
    // not then render a button whose only outcome is an error.
    expect(shellActions(USER, "editing", false).saveToWorkspace).toBe(false);
  });

  it("does not show an authenticated user the guest upsell", () => {
    expect(shellActions(USER, "editing", true).guestSaveUpsell).toBe(false);
    expect(shellActions(USER, "editing", false).guestSaveUpsell).toBe(false);
  });
});

describe("guest signup link", () => {
  it("returns the visitor to the editor, not to a dashboard", () => {
    expect(GUEST_SAVE_SIGNUP_HREF).toContain("returnTo=");
    const returnTo = decodeURIComponent(
      new URL(GUEST_SAVE_SIGNUP_HREF, "https://example.test").searchParams.get("returnTo") ?? "",
    );
    expect(returnTo).toBe("/editor");
  });

  it("is a relative path, so it cannot be an open redirect", () => {
    expect(GUEST_SAVE_SIGNUP_HREF.startsWith("/")).toBe(true);
    expect(GUEST_SAVE_SIGNUP_HREF.startsWith("//")).toBe(false);
  });
});

describe("viewerInitials", () => {
  it("uses first and last name", () => {
    expect(viewerInitials(USER)).toBe("FA");
  });

  it("falls back to the email when there is no name", () => {
    expect(viewerInitials({ email: "zoe@example.com", name: null })).toBe("ZO");
  });

  it("handles a single name", () => {
    expect(viewerInitials({ email: "x@y.z", name: "Prince" })).toBe("PR");
  });

  it("never throws for an empty viewer", () => {
    expect(viewerInitials({ email: null, name: null })).toBe("?");
  });
});

/**
 * T7 — a failed Workspace save must end in an honest, actionable message.
 *
 * The categories exist because the server's own sentences are written for an API
 * consumer: the CAS rejection reads "Document revision 4 does not match the
 * expected revision 3. Reload and retry.", and pasting that into a banner puts a
 * revision number in front of someone who has never heard of one. Classifying
 * first also keeps the banner bounded — no server text of unknown length or
 * content reaches the DOM.
 */
describe("classifyWorkspaceSaveFailure", () => {
  it("reads a compare-and-swap rejection as a conflict, by status or by code", () => {
    expect(classifyWorkspaceSaveFailure(409, null)).toBe("conflict");
    expect(classifyWorkspaceSaveFailure(400, "WORKSPACE_OPERATION_REJECTED")).toBe("conflict");
  });

  it("separates the failures a retry cannot fix", () => {
    expect(classifyWorkspaceSaveFailure(413, "PAYLOAD_TOO_LARGE")).toBe("too_large");
    expect(classifyWorkspaceSaveFailure(401, null)).toBe("unauthorized");
    expect(classifyWorkspaceSaveFailure(403, "FORBIDDEN")).toBe("unauthorized");
  });

  it("classifies an unparseable response rather than throwing", () => {
    // A proxy returning HTML must still end in a message, not a TypeError.
    expect(classifyWorkspaceSaveFailure(502, null)).toBe("unknown");
    expect(classifyWorkspaceSaveFailure(500, null)).toBe("unknown");
  });
});

describe("workspaceSaveFailureMessage", () => {
  const failures = ["conflict", "too_large", "unauthorized", "unknown"] as const;

  it("never claims anything was saved", () => {
    for (const failure of failures) {
      const message = workspaceSaveFailureMessage(failure);
      expect(message).not.toMatch(/\bsaved\b/i);
      expect(message.length).toBeGreaterThan(20);
      expect(message.length).toBeLessThan(240);
    }
  });

  it("says the work is still here whenever a retry is the next step", () => {
    // The dangerous reading of a failed save is "my edits are gone", which is what
    // makes users close the tab over work that is still in memory.
    expect(workspaceSaveFailureMessage("conflict")).toMatch(/still here/i);
    expect(workspaceSaveFailureMessage("unknown")).toMatch(/still here/i);
  });

  it("points at export when the Workspace cannot take this document", () => {
    expect(workspaceSaveFailureMessage("too_large")).toMatch(/export/i);
    expect(workspaceSaveFailureMessage("unauthorized")).toMatch(/export|sign in/i);
  });
});
