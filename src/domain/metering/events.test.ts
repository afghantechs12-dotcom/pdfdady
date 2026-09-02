import { describe, expect, it } from "vitest";
import {
  ALL_ANALYTICS_EVENTS,
  ANALYTICS_EVENTS,
  CLIENT_INGESTIBLE_EVENTS,
  MAX_PROPERTY_VALUE_LENGTH,
  PRIVACY_DENYLIST,
  isClientIngestibleEvent,
  allowedPropertiesFor,
  isKnownEvent,
  sanitizeEventProperties,
  taxonomyPrivacyViolations,
} from "./events";

/**
 * The taxonomy's job is to make it impossible to accidentally record PII. The
 * tests therefore attack it the way a careless call site would: by handing it
 * exactly the sensitive fields the recorder's doc comment forbids.
 */
describe("privacy of the declared taxonomy", () => {
  it("declares no property that is on the denylist", () => {
    expect(taxonomyPrivacyViolations()).toEqual([]);
  });

  it("has a non-empty denylist covering the obvious leaks", () => {
    for (const banned of ["filename", "email", "text", "content", "ownerid", "path"]) {
      expect(PRIVACY_DENYLIST).toContain(banned);
    }
  });
});

describe("allowlist sanitisation", () => {
  /**
   * The core promise: a property nobody declared does not reach a store. This is
   * what protects against a future `track("download", { filename })` that nobody
   * reviewed.
   */
  it("drops undeclared properties", () => {
    const clean = sanitizeEventProperties("download", {
      format: "pdf",
      filename: "Q3-layoffs.pdf",
      email: "a@b.com",
    });
    expect(clean).toEqual({ format: "pdf" });
    expect(clean).not.toHaveProperty("filename");
    expect(clean).not.toHaveProperty("email");
  });

  it("keeps declared common and event-specific properties", () => {
    const clean = sanitizeEventProperties("job_failed", {
      toolSlug: "compress-pdf",
      plan: "free",
      errorCategory: "corrupt_document",
    });
    expect(clean).toEqual({
      toolSlug: "compress-pdf",
      plan: "free",
      errorCategory: "corrupt_document",
    });
  });

  /**
   * A nested value is where `{ file: { name } }` sneaks a filename past a flat
   * allowlist. Objects and arrays are dropped even under a declared key.
   */
  it("drops non-primitive values even under an allowed key", () => {
    const clean = sanitizeEventProperties("job_succeeded", {
      durationMs: { nested: "evil" } as never,
      pageCount: [1, 2, 3] as never,
    });
    expect(clean).toEqual({});
  });

  it("drops null and undefined values", () => {
    const clean = sanitizeEventProperties("file_selected", {
      fileCount: null as never,
      toolSlug: undefined as never,
    });
    expect(clean).toEqual({});
  });

  it("returns nothing for an unknown event, so a stale client cannot inject keys", () => {
    expect(sanitizeEventProperties("legacy_event", { toolSlug: "x" })).toEqual({});
  });

  it("even drops a denylisted key that was mistakenly declared-looking", () => {
    // `ownerId` is never in any allowlist, so it is dropped by the allowlist and
    // would also be caught by the denylist. Belt and suspenders.
    const clean = sanitizeEventProperties("tool_processing_completed", {
      jobId: "job_123",
      ownerId: "user_secret",
    });
    expect(clean).toEqual({ jobId: "job_123" });
  });
});

describe("event recognition", () => {
  it("recognises exactly the declared names", () => {
    for (const name of ALL_ANALYTICS_EVENTS) expect(isKnownEvent(name)).toBe(true);
    expect(isKnownEvent("tool_view")).toBe(true);
    expect(isKnownEvent("made_up")).toBe(false);
  });

  it("includes the funnel spine and the server outcome event", () => {
    for (const name of [
      "tool_view",
      "tool_start",
      "file_selected",
      "job_submitted",
      "job_succeeded",
      "job_failed",
      "download",
      "limit_reached",
    ]) {
      expect(ALL_ANALYTICS_EVENTS).toContain(name);
    }
    // The server recorder's event name must be in the taxonomy so its properties
    // are sanitised on the same path as everything else.
    expect(ANALYTICS_EVENTS.tool_processing_completed).toBe("tool_processing_completed");
  });

  it("exposes the allowed property set for a known event", () => {
    const allowed = allowedPropertiesFor("limit_reached");
    expect(allowed.has("meter")).toBe(true);
    expect(allowed.has("reason")).toBe(true);
    expect(allowed.has("plan")).toBe(true); // common
    expect(allowed.has("filename")).toBe(false);
  });
});

/**
 * The client-ingestible subset is a trust boundary, not a convenience list. Every
 * name NOT on it is one that only the server can honestly report, and admitting
 * one would let anyone write numbers into the dataset the dashboards read.
 */
describe("client-ingestible subset", () => {
  it("is a strict subset of the taxonomy", () => {
    for (const name of CLIENT_INGESTIBLE_EVENTS) {
      expect(ALL_ANALYTICS_EVENTS).toContain(name);
    }
    expect(CLIENT_INGESTIBLE_EVENTS.length).toBeLessThan(ALL_ANALYTICS_EVENTS.length);
  });

  it("excludes every server-authoritative event", () => {
    for (const name of [
      ANALYTICS_EVENTS.tool_processing_completed,
      ANALYTICS_EVENTS.limit_reached,
      ANALYTICS_EVENTS.signup,
      ANALYTICS_EVENTS.login,
    ]) {
      expect(isClientIngestibleEvent(name)).toBe(false);
    }
  });

  it("admits the funnel spine a browser is the only witness to", () => {
    for (const name of [
      ANALYTICS_EVENTS.tool_view,
      ANALYTICS_EVENTS.file_selected,
      ANALYTICS_EVENTS.tool_start,
      ANALYTICS_EVENTS.job_submitted,
      ANALYTICS_EVENTS.job_succeeded,
      ANALYTICS_EVENTS.job_failed,
      ANALYTICS_EVENTS.download,
    ]) {
      expect(isClientIngestibleEvent(name)).toBe(true);
    }
  });

  it("rejects an unknown name", () => {
    expect(isClientIngestibleEvent("tool_view_v2")).toBe(false);
    expect(isClientIngestibleEvent("")).toBe(false);
  });
});

/**
 * The allowlist checks the KEY. These pin the value side: a declared key is not a
 * licence to store a kilobyte of text, or a NaN that reads as a missing
 * measurement rather than a bad one.
 */
describe("property values", () => {
  it("truncates an over-long string instead of storing it whole", () => {
    const clean = sanitizeEventProperties("tool_view", {
      toolSlug: "x".repeat(MAX_PROPERTY_VALUE_LENGTH + 500),
    });
    expect((clean.toolSlug as string).length).toBe(MAX_PROPERTY_VALUE_LENGTH);
  });

  it("keeps a value at exactly the cap", () => {
    const value = "y".repeat(MAX_PROPERTY_VALUE_LENGTH);
    expect(sanitizeEventProperties("tool_view", { toolSlug: value }).toolSlug).toBe(value);
  });

  it("drops NaN and Infinity, which would read as a missing measurement", () => {
    const clean = sanitizeEventProperties("job_succeeded", {
      durationMs: Number.NaN,
      pageCount: Number.POSITIVE_INFINITY,
    });
    expect("durationMs" in clean).toBe(false);
    expect("pageCount" in clean).toBe(false);
  });

  it("keeps zero and negative finite numbers", () => {
    const clean = sanitizeEventProperties("job_succeeded", { durationMs: 0, pageCount: -1 });
    expect(clean.durationMs).toBe(0);
    expect(clean.pageCount).toBe(-1);
  });
});
