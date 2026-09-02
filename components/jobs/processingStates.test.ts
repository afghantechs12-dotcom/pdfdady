import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JobStatePanel } from "./JobStatePanel";
import type { JobStatusResponse } from "@/lib/tools/processingJobStatus";

/**
 * U9 — processing states remain distinct.
 *
 * `ServerToolRunner` holds the idle/processing/done/error switch in `useState`,
 * so it cannot be walked here — but it delegates every non-idle state to this
 * panel, which is fully prop-driven. Rendering all seven job statuses is
 * therefore a real rendered test rather than a source scan, and it is the
 * strongest version of the claim: not "the states exist" but "no two of them
 * look alike, and each one leaves a way forward".
 *
 * The in-flight → done transition on a real upload is probe C3/C4/D3/D4/D6.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/tools/compress-pdf",
  useSearchParams: () => new URLSearchParams(),
}));

const job = (over: Partial<JobStatusResponse> = {}): JobStatusResponse => ({
  id: "job-1",
  toolSlug: "compress-pdf",
  status: "running",
  stage: "processing",
  stageLabel: "Compressing",
  progress: 60,
  attempt: 1,
  maxAttempts: 3,
  resultAvailable: false,
  retryable: false,
  cancellable: true,
  errorCategory: null,
  error: null,
  createdAt: "2026-09-02T10:00:00.000Z",
  startedAt: "2026-09-02T10:00:01.000Z",
  finishedAt: null,
  expiresAt: null,
  inputBytes: null,
  outputBytes: null,
  outputFileName: null,
  outputMimeType: null,
  ...over,
});

const render = (over: Partial<JobStatusResponse> = {}, props = {}) =>
  renderToStaticMarkup(
    h(JobStatePanel, {
      job: job(over),
      executionNote: "This runs on our server.",
      onCancel: () => {},
      onRetry: () => {},
      onDownload: () => {},
      onStartOver: () => {},
      ...props,
    }),
  );

/**
 * Visible text only — the class soup says nothing about what a user reads.
 * Entities are decoded so an assertion can be written the way the copy reads
 * ("didn't", not "didn&#x27;t").
 */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/\s+/gu, " ")
    .trim();

const STATES = {
  created: job({ status: "created", stage: "queued", stageLabel: "Queued" }),
  running: job(),
  completed: job({
    status: "completed",
    resultAvailable: true,
    outputFileName: "report-compressed.pdf",
    outputMimeType: "application/pdf",
    stage: "done",
    stageLabel: "Done",
  }),
  cancelled: job({ status: "cancelled", cancellable: false }),
  expired: job({ status: "expired", cancellable: false }),
  failed_retryable: job({
    status: "failed",
    retryable: true,
    cancellable: false,
    error: "The file could not be read.",
  }),
  failed_permanent: job({
    status: "failed",
    retryable: false,
    cancellable: false,
    error: "This PDF is password protected.",
  }),
};

describe("U9 — processing states remain distinct", () => {
  it("renders a different sentence for every job status", () => {
    const seen = new Map<string, string>();
    for (const [name, value] of Object.entries(STATES)) {
      const body = text(render(value));
      expect(body.length, name).toBeGreaterThan(10);
      for (const [other, previous] of seen) {
        expect(body, `${name} reads the same as ${other}`).not.toBe(previous);
      }
      seen.set(name, body);
    }
    expect(seen.size).toBe(7);
  });

  it("shows progress and a way to stop while work is in flight", () => {
    const html = render();
    expect(text(html)).toContain("Compressing");
    expect(text(html)).toContain("This runs on our server.");
    expect(text(html)).toContain("Cancel");
    // Nothing that implies a result exists yet.
    expect(text(html)).not.toContain("Download");
    expect(text(html)).not.toContain("ready");
  });

  it("distinguishes cancelling-in-progress from cancelled", () => {
    // The worker checks between steps, so the honest word is "Stopping".
    const inFlight = text(render({}, { cancelling: true }));
    expect(inFlight).toContain("Cancelling…");
    expect(inFlight).toContain("Stopping the job");
    const done = text(render(STATES.cancelled));
    expect(done).toContain("Cancelled");
    expect(done).not.toContain("Stopping");
    expect(done).toContain("deleted from the server");
  });

  it("names the file in the success state, so three tabs are not three identical screens", () => {
    const html = render(STATES.completed);
    expect(text(html)).toContain("Your file is ready");
    expect(text(html)).toContain("report-compressed.pdf");
  });

  it("reports a size comparison only when both sizes are known", () => {
    const withSizes = text(
      render(STATES.completed, {
        inputBytes: 1_000_000,
        outputBytes: 700_000,
        showSizeComparison: true,
      }),
    );
    expect(withSizes).toMatch(/30% smaller/);
    // Without the counts the panel says nothing rather than inventing a ratio.
    expect(text(render(STATES.completed, { showSizeComparison: true }))).not.toMatch(/smaller/);
  });

  it("offers retry for a retryable failure and withholds it for a permanent one", () => {
    const retryable = text(render(STATES.failed_retryable));
    expect(retryable).toContain("That didn't work");
    expect(retryable).toContain("Try again");
    const permanent = text(render(STATES.failed_permanent));
    expect(permanent).toContain("This file can't be processed");
    // Offering a retry here would invite three attempts at a known outcome.
    expect(permanent).not.toContain("Try again");
    expect(permanent).toContain("won't change the outcome");
  });

  it("stops offering retry once every attempt is spent", () => {
    const spent = text(render({ ...STATES.failed_retryable, attempt: 3, maxAttempts: 3 }));
    expect(spent).toContain("All 3 attempts were used");
    expect(spent).not.toContain("Try again");
    expect(spent).toContain("Start over");
  });

  it("leaves every terminal state with a recovery action", () => {
    for (const name of ["cancelled", "expired", "failed_retryable", "failed_permanent"] as const) {
      expect(text(render(STATES[name])), name).toMatch(/Start over|Try again/);
    }
  });

  it("displays the server's error sentence verbatim and adds nothing to it", () => {
    const html = text(render(STATES.failed_permanent));
    expect(html).toContain("This PDF is password protected.");
    // No path, no stack, no internal service name can reach the panel: it prints
    // `job.error`, which the API derives from a category.
    expect(html).not.toMatch(/\/(?:var|home|Users)\/|at [A-Z]\w+\./);
  });
});
