import { PrismaClient } from "@prisma/client";
import type { FeatureFlag } from "@/src/domain/entities/FeatureFlag";
import type {
  IFeatureFlagRepository,
  FeatureFlagUpsertInput,
} from "@/src/application/ports/repositories/FeatureFlagRepository";
import type { ILogger } from "@/src/application/ports/Logger";

type FeatureFlagRow = {
  key: string;
  enabled: boolean;
  value: string | null;
  updatedAt: Date;
};

function toDomain(row: FeatureFlagRow): FeatureFlag {
  return {
    key: row.key,
    enabled: row.enabled,
    value: row.value,
    updatedAt: row.updatedAt,
  };
}

/**
 * Prisma-backed FeatureFlagRepository. Maps Prisma rows to the domain entity;
 * the application layer only ever sees `IFeatureFlagRepository` + `FeatureFlag`,
 * never Prisma types. Swapping to another provider means a new adapter
 * implementing the same interface.
 */
export class PrismaFeatureFlagRepository implements IFeatureFlagRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: ILogger,
  ) {}

  async get(key: string): Promise<FeatureFlag | null> {
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    return row ? toDomain(row) : null;
  }

  async getAll(): Promise<FeatureFlag[]> {
    const rows = await this.prisma.featureFlag.findMany();
    return rows.map(toDomain);
  }

  async upsert(input: FeatureFlagUpsertInput): Promise<FeatureFlag> {
    const row = await this.prisma.featureFlag.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        enabled: input.enabled,
        value: input.value ?? null,
      },
      update: {
        enabled: input.enabled,
        value: input.value ?? null,
      },
    });
    return toDomain(row);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.prisma.featureFlag.delete({ where: { key } });
    } catch (err) {
      // P2025 = record not found; delete is idempotent.
      if ((err as { code?: string }).code !== "P2025") {
        this.logger.warn("Feature flag delete failed", { key, error: String(err) });
        throw err;
      }
    }
  }
}
