/**
 * Analytics port — product analytics events (the Phase 1.5 taxonomy: page_view,
 * tool_start, job_succeeded, file_uploaded, download, ai_message, signup,
 * upgrade_view, …). The local adapter logs events as structured JSON; a
 * PostHog adapter (privacy-first, self-hosted per the audit) ships them later.
 *
 * Event properties must never include PII (filenames, file content) — size
 * buckets + non-identifying metadata only.
 */
export type AnalyticsProperties = Record<string, unknown>;

export interface IAnalytics {
  track(event: string, properties?: AnalyticsProperties): void;
  /** Associates subsequent events with a user (after login). */
  identify(userId: string, traits?: AnalyticsProperties): void;
}
