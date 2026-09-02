import type { FeatureFlag } from "@/src/domain/entities/FeatureFlag";
import type {
  IFeatureFlagRepository,
  FeatureFlagUpsertInput,
} from "@/src/application/ports/repositories/FeatureFlagRepository";

/**
 * In-memory FeatureFlagRepository — used by tests and as a zero-dependency
 * fallback when no database is available. Implements the same interface as the
 * Prisma adapter, so the FeatureFlagService cannot tell them apart.
 */
export class InMemoryFeatureFlagRepository implements IFeatureFlagRepository {
  private readonly flags = new Map<string, FeatureFlag>();

  async get(key: string): Promise<FeatureFlag | null> {
    return this.flags.get(key) ?? null;
  }

  async getAll(): Promise<FeatureFlag[]> {
    return [...this.flags.values()];
  }

  async upsert(input: FeatureFlagUpsertInput): Promise<FeatureFlag> {
    const existing = this.flags.get(input.key);
    const flag: FeatureFlag = {
      key: input.key,
      enabled: input.enabled,
      value: input.value ?? existing?.value ?? null,
      updatedAt: new Date(),
    };
    this.flags.set(input.key, flag);
    return flag;
  }

  async delete(key: string): Promise<void> {
    this.flags.delete(key);
  }
}
