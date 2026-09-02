/**
 * HealthCheck port — a named, async readiness probe.
 *
 * The health endpoint collects all registered checks and aggregates them into
 * a single readiness verdict. Adapters (DB ping, storage head, queue latency)
 * implement this; the presentation layer never knows which subsystems exist.
 */
export interface HealthResult {
  name: string;
  healthy: boolean;
  /** Optional human-readable detail (never secrets). */
  detail?: string;
}

export interface IHealthCheck {
  readonly name: string;
  check(): Promise<HealthResult>;
}
