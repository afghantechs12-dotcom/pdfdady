/**
 * Metrics port — counters, gauges, and histograms.
 *
 * The local adapter logs to the console (dev); a Prometheus/Datadog adapter
 * would ship these to a metrics backend. The application emits metrics through
 * this interface only, so the backend is swappable without touching business
 * logic.
 */
export type MetricTags = Record<string, string | number | boolean>;

export interface IMetrics {
  increment(name: string, value?: number, tags?: MetricTags): void;
  gauge(name: string, value: number, tags?: MetricTags): void;
  histogram(name: string, value: number, tags?: MetricTags): void;
}
