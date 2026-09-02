import type {
  IAnalytics,
  AnalyticsProperties,
} from "@/src/application/ports/observability/Analytics";
import type { ILogger } from "@/src/application/ports/Logger";

/**
 * Local IAnalytics adapter — emits product events as structured JSON via
 * ILogger (info). A PostHog adapter (self-hosted, privacy-first) ships events
 * later without changing call sites. `identify` records the user id on
 * subsequent events.
 */
export class ConsoleAnalytics implements IAnalytics {
  private userId: string | null = null;
  private traits: AnalyticsProperties = {};

  constructor(private readonly logger: ILogger) {}

  track(event: string, properties?: AnalyticsProperties): void {
    this.logger.info("analytics", {
      event,
      userId: this.userId,
      ...this.traits,
      ...properties,
    });
  }

  identify(userId: string, traits?: AnalyticsProperties): void {
    this.userId = userId;
    if (traits) this.traits = { ...this.traits, ...traits };
    this.logger.debug("analytics.identify", { userId });
  }
}
