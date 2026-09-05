import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The compress ceiling is handed straight to `setTimeout` in
 * `ProcessingJobHandler`, which has no opinion about its argument: `""` becomes
 * 0, a typo becomes NaN, and both mean "fire on the next tick". An operator who
 * writes `PROCESSING_COMPRESS_TIMEOUT_MS=3m` would not get three minutes and
 * would not get an error — every pipeline compress job would abort instantly and
 * be reported as a timeout, which points the investigation at Ghostscript
 * instead of at the env file. Same reasoning, and same guard shape, as
 * `WORKER_STALE_JOB_AFTER_MS` in `StuckJobRecoveryService`.
 */
describe("compress timeout configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadWith(value: string | undefined): Promise<number> {
    vi.resetModules();
    vi.stubEnv("PROCESSING_COMPRESS_TIMEOUT_MS", value);
    const mod = await import("./processorRegistry");
    return mod.COMPRESS_PDF_TIMEOUT_MS;
  }

  it("uses a valid override", async () => {
    expect(await loadWith("45000")).toBe(45_000);
  });

  it.each(["", "3m", "abc", "0", "-1", "undefined"])(
    "falls back to three minutes for %o rather than aborting every job",
    async (value) => {
      expect(await loadWith(value)).toBe(180_000);
    },
  );

  it("falls back when unset", async () => {
    expect(await loadWith(undefined)).toBe(180_000);
  });

  it("hands the ceiling to the registered pilot processor", async () => {
    vi.resetModules();
    vi.stubEnv("PROCESSING_COMPRESS_TIMEOUT_MS", "abc");
    const { buildProcessorRegistry } = await import("./processorRegistry");
    const registry = buildProcessorRegistry();
    // The pilot is deliberately alone: migrating a tool is adding it here.
    expect(registry.ids()).toEqual(["compress-pdf"]);
    expect(registry.require("compress-pdf").timeoutMs).toBe(180_000);
  });
});
