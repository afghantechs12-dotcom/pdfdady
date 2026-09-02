import type { IFeatureFlagService } from "@/src/application/ports/featureflags/FeatureFlagService";
import type { IFeatureFlagRepository } from "@/src/application/ports/repositories/FeatureFlagRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type { FeatureFlag } from "@/src/domain/entities/FeatureFlag";

interface CacheEntry {
  flag: FeatureFlag | null;
  expiresAt: number;
}

/**
 * Application service that reads feature flags through the repository port.
 *
 * - Caches lookups in-process for `ttlMs` to avoid a DB round-trip per check.
 * - Degrades gracefully: if the repository throws (DB down), it logs a warning
 *   and treats the flag as missing → disabled, so the app keeps running.
 *
 * This is the only flag API the rest of the application should use; it depends
 * on the `IFeatureFlagRepository` interface, not on Prisma.
 */
export class FeatureFlagService implements IFeatureFlagService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly repo: IFeatureFlagRepository,
    private readonly logger: ILogger,
    ttlMs = 15_000,
  ) {
    this.ttlMs = ttlMs;
  }

  async isEnabled(key: string): Promise<boolean> {
    const flag = await this.get(key);
    return flag?.enabled === true;
  }

  async getValue<T = string>(key: string): Promise<T | null> {
    const flag = await this.get(key);
    if (!flag || !flag.enabled || !flag.value) return null;
    try {
      return JSON.parse(flag.value) as T;
    } catch {
      return flag.value as unknown as T;
    }
  }

  async refresh(key?: string): Promise<void> {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  private async get(key: string): Promise<FeatureFlag | null> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.flag;

    let flag: FeatureFlag | null = null;
    try {
      flag = await this.repo.get(key);
    } catch (err) {
      this.logger.warn("Feature flag lookup failed; defaulting to disabled", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      // flag stays null (the initializer above) — the lookup failed.
    }
    this.cache.set(key, { flag, expiresAt: Date.now() + this.ttlMs });
    return flag;
  }
}
