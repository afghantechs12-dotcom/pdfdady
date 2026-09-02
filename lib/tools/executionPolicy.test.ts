import { describe, expect, it } from "vitest";
import { tools as TOOLS } from "@/data/tools";
import {
  LOCAL_TOOL_SLUGS,
  REMOTE_JOB_REASON,
  REMOTE_JOB_TOOL_SLUGS,
  TOOL_EXECUTION_MATRIX,
  ToolExecutionModeError,
  assertRemoteJobTool,
  executionCopyForSlug,
  executionModeForSlug,
  executionModeForStatus,
  executionPolicyDisagreements,
  isLocalTool,
  processingModeForExecutionMode,
  requiresRemoteJob,
} from "./executionPolicy";

/**
 * The execution policy is the single authority on where a tool runs. Its value
 * comes entirely from being the only such authority — so these tests are less
 * about the mapping (which is small) and more about the properties that stop a
 * second, disagreeing derivation from creeping back in.
 */
describe("execution mode classification", () => {
  it("maps each tool status to exactly one mode, or to none", () => {
    expect(executionModeForStatus("functional-client")).toBe("local");
    expect(executionModeForStatus("functional-server")).toBe("remote_job");
    // A tool that is not built yet has no execution mode. Defaulting it to either
    // one would put an unimplemented tool on a real code path.
    expect(executionModeForStatus("planned")).toBeNull();
    expect(executionModeForStatus("coming-soon-ai")).toBeNull();
  });

  it("classifies every real tool consistently with its status", () => {
    for (const tool of TOOLS) {
      expect(executionModeForSlug(tool.slug)).toBe(
        executionModeForStatus(tool.status),
      );
    }
  });

  it("returns null for an unknown slug rather than guessing", () => {
    expect(executionModeForSlug("not-a-tool")).toBeNull();
    expect(isLocalTool("not-a-tool")).toBe(false);
    expect(requiresRemoteJob("not-a-tool")).toBe(false);
  });

  it("never classifies a tool as both local and remote", () => {
    for (const slug of LOCAL_TOOL_SLUGS) {
      expect(REMOTE_JOB_TOOL_SLUGS.has(slug)).toBe(false);
    }
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      expect(LOCAL_TOOL_SLUGS.has(slug)).toBe(false);
    }
  });

  it("derives the slug sets from the tool registry, not a hand-written list", () => {
    // If these sets were typed by hand they would drift the first time a tool
    // changed status. Deriving them means the drift is impossible.
    const expectedLocal = TOOLS.filter((t) => t.status === "functional-client").map(
      (t) => t.slug,
    );
    const expectedRemote = TOOLS.filter((t) => t.status === "functional-server").map(
      (t) => t.slug,
    );
    expect([...LOCAL_TOOL_SLUGS].sort()).toEqual(expectedLocal.sort());
    expect([...REMOTE_JOB_TOOL_SLUGS].sort()).toEqual(expectedRemote.sort());
  });
});

describe("the local tools stay local", () => {
  // These four are the tools the brief names as working well in the browser. If
  // one of them ever classified as remote_job, user documents would start being
  // uploaded for an operation that never needed to leave the device.
  for (const slug of ["merge-pdf", "split-pdf", "rotate-pdf", "organize-pdf"]) {
    it(`${slug} is local`, () => {
      expect(isLocalTool(slug)).toBe(true);
      expect(requiresRemoteJob(slug)).toBe(false);
      expect(executionModeForSlug(slug)).toBe("local");
    });
  }
});

describe("the remote allowlist is the API gate", () => {
  it("accepts every remote tool", () => {
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      expect(() => assertRemoteJobTool(slug)).not.toThrow();
    }
  });

  it("rejects a local tool, so a job can never be created for one", () => {
    for (const slug of LOCAL_TOOL_SLUGS) {
      expect(() => assertRemoteJobTool(slug)).toThrow(ToolExecutionModeError);
    }
  });

  it("rejects unknown, empty and injection-shaped slugs", () => {
    for (const bad of [
      "",
      "unknown-tool",
      "../../etc/passwd",
      "compress-pdf; rm -rf /",
      "COMPRESS-PDF",
      "compress-pdf ",
    ]) {
      expect(() => assertRemoteJobTool(bad)).toThrow(ToolExecutionModeError);
    }
  });

  it("carries the offending slug on the error for logging", () => {
    try {
      assertRemoteJobTool("merge-pdf");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionModeError);
      expect((err as ToolExecutionModeError).slug).toBe("merge-pdf");
    }
  });
});

describe("the execution matrix", () => {
  it("covers every tool exactly once", () => {
    expect(TOOL_EXECUTION_MATRIX).toHaveLength(TOOLS.length);
    const slugs = TOOL_EXECUTION_MATRIX.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.sort()).toEqual(TOOLS.map((t) => t.slug).sort());
  });

  it("agrees with the classification functions for every entry", () => {
    for (const entry of TOOL_EXECUTION_MATRIX) {
      expect(entry.mode).toBe(executionModeForSlug(entry.slug));
    }
  });

  it("gives every remote_job tool a stated reason", () => {
    // "Why is this not local?" must have a written answer per tool, because the
    // default preference is local and each exception is a decision.
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      expect(REMOTE_JOB_REASON[slug], `missing reason for ${slug}`).toBeTruthy();
      expect(REMOTE_JOB_REASON[slug].length).toBeGreaterThan(20);
    }
  });

  it("states no reason for a tool that is not remote_job", () => {
    // A stale reason left behind after a tool moved local would be a misleading
    // justification for a decision no longer in force.
    for (const slug of Object.keys(REMOTE_JOB_REASON)) {
      expect(
        REMOTE_JOB_TOOL_SLUGS.has(slug),
        `${slug} has a remote-job reason but is not a remote-job tool`,
      ).toBe(true);
    }
  });
});

describe("privacy copy is derived, not hard-coded per page", () => {
  it("maps local to browser copy and remote_job to secure-cloud copy", () => {
    expect(processingModeForExecutionMode("local")).toBe("browser");
    expect(processingModeForExecutionMode("remote_job")).toBe("secure-cloud");
  });

  it("gives a local tool browser copy that does not promise an upload", () => {
    const copy = executionCopyForSlug("merge-pdf");
    expect(copy?.mode).toBe("browser");
    expect(copy?.description.toLowerCase()).not.toContain("uploaded over");
  });

  it("gives a remote tool secure-cloud copy that admits the upload", () => {
    const copy = executionCopyForSlug("compress-pdf");
    expect(copy?.mode).toBe("secure-cloud");
    // The one claim that must be present: the file does go to a server. A page
    // that renders "stays on your device" while POSTing bytes is the exact
    // failure this centralization exists to prevent.
    expect(copy?.description.toLowerCase()).toMatch(/server|cloud|upload/);
  });

  it("returns null for a tool with no execution mode", () => {
    const planned = TOOLS.find((t) => t.status === "planned");
    if (planned) expect(executionCopyForSlug(planned.slug)).toBeNull();
  });
});

describe("policy consistency invariant", () => {
  it("finds no disagreement between the execution policy and the processing-mode copy", () => {
    // The guard that makes this module authoritative rather than merely
    // additional: if the older processingMode mapping ever said something
    // different about a tool, this fails and names the tool.
    expect(executionPolicyDisagreements()).toEqual([]);
  });
});
