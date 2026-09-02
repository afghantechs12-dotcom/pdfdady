import { PrismaClient } from "@prisma/client";
import type { IHealthCheck, HealthResult } from "@/src/application/ports/HealthCheck";
import type { ILogger } from "@/src/application/ports/Logger";

/**
 * Database readiness probe — issues a `SELECT 1` (works on both SQLite and
 * Postgres) and reports healthy/unhealthy. Used by the readiness endpoint via
 * the DI container; the endpoint never knows which DB is behind it.
 */
export class DbHealthCheck implements IHealthCheck {
  readonly name = "database";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
  ) {}

  async check(): Promise<HealthResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { name: this.name, healthy: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "database unreachable";
      this.logger.warn("DB health check failed", { detail });
      return { name: this.name, healthy: false, detail };
    }
  }
}
