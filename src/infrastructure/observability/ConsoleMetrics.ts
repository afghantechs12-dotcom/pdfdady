import type { IMetrics, MetricTags } from "@/src/application/ports/observability/Metrics";
import type { ILogger } from "@/src/application/ports/Logger";

/**
 * Local IMetrics adapter — logs metric points as structured JSON via ILogger
 * (debug level, so prod `info` filtering keeps them quiet unless debug is on).
 * A Prometheus/Datadog adapter replaces this in production.
 */
export class ConsoleMetrics implements IMetrics {
  constructor(private readonly logger: ILogger) {}

  increment(name: string, value = 1, tags?: MetricTags): void {
    this.logger.debug("metric.increment", { metric: name, value, ...tags });
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.logger.debug("metric.gauge", { metric: name, value, ...tags });
  }

  histogram(name: string, value: number, tags?: MetricTags): void {
    this.logger.debug("metric.histogram", { metric: name, value, ...tags });
  }
}
